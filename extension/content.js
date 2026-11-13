/*
 * iNat Batch Annotate — content script.
 *
 * Adds a side panel to www.inaturalist.org. In the panel you load a set of
 * observations (from the current page's filters or any iNat search query),
 * select some, pick annotation values, and apply them to all selected
 * observations. The same rules the iNat website uses decide which annotations
 * apply to which taxa (ported from app/webpack/observations/show/ducks/
 * controlled_terms.js#termsForTaxon and components/annotations.jsx). The server
 * also validates every annotation, so the client checks are a preview only.
 */
( () => {
  if ( window.__inatBatchAnnotate ) return;
  window.__inatBatchAnnotate = true;

  const ext = globalThis.browser || globalThis.chrome;
  const API = "https://api.inaturalist.org/v1";
  const WRITE_DELAY_MS = 1100; // iNat asks API clients to stay near 1 request/second.
  const MAX_PER_PAGE = 200;

  const state = {
    open: false,
    token: null,
    me: null,
    terms: [],
    obs: [],
    selected: new Set( ),
    picks: new Map( ), // attribute id -> value id
    results: new Map( ), // observation id -> [{ kind, text }]
    loading: false,
    running: false,
    stopRequested: false,
    lastClickedIndex: null
  };

  // ---------------------------------------------------------------- utilities

  const sleep = ms => new Promise( r => setTimeout( r, ms ) );

  function h( tag, attrs = {}, ...children ) {
    const el = document.createElement( tag );
    for ( const [k, v] of Object.entries( attrs || {} ) ) {
      if ( v === null || v === undefined || v === false ) continue;
      if ( k === "class" ) el.className = v;
      else if ( k.startsWith( "on" ) ) el.addEventListener( k.slice( 2 ), v );
      else if ( k in el && typeof v !== "string" ) el[k] = v;
      else el.setAttribute( k, v === true ? "" : v );
    }
    for ( const c of children.flat( ) ) {
      if ( c === null || c === undefined || c === false ) continue;
      el.append( c instanceof Node ? c : document.createTextNode( String( c ) ) );
    }
    return el;
  }

  async function getToken( ) {
    const meta = document.querySelector( "meta[name='inaturalist-api-token']" );
    if ( meta && meta.content ) return meta.content;
    const r = await fetch( "/users/api_token", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    } );
    if ( !r.ok || !( r.headers.get( "content-type" ) || "" ).includes( "json" ) ) {
      throw new Error( "You are not signed in to iNaturalist." );
    }
    return ( await r.json( ) ).api_token;
  }

  function errorText( json, status ) {
    if ( !json ) return `HTTP ${status}`;
    const e = json.error;
    if ( e && e.original && e.original.error ) {
      const o = e.original.error;
      return Array.isArray( o ) ? o.join( "; " ) : String( o );
    }
    if ( Array.isArray( e ) ) return e.join( "; " );
    if ( typeof e === "string" ) return e;
    if ( e && e.original ) return JSON.stringify( e.original );
    return json.message || `HTTP ${status}`;
  }

  async function api( method, path, { params, body, auth = true } = {} ) {
    const url = new URL( API + path );
    if ( params ) {
      new URLSearchParams( params ).forEach( ( v, k ) => url.searchParams.set( k, v ) );
    }
    const headers = { Accept: "application/json" };
    if ( auth && state.token ) headers.Authorization = state.token;
    if ( body ) headers["Content-Type"] = "application/json";
    const r = await fetch( url, {
      method,
      headers,
      body: body ? JSON.stringify( body ) : undefined
    } );
    let json = null;
    try { json = await r.json( ); } catch ( _e ) { /* empty body */ }
    if ( !r.ok ) {
      const err = new Error( errorText( json, r.status ) );
      err.status = r.status;
      throw err;
    }
    return json;
  }

  // Port of termsForTaxon from the iNat web app.
  function termsForTaxon( terms, taxon ) {
    const ancestorIds = taxon && taxon.ancestor_ids ? taxon.ancestor_ids : [];
    const has = ( ids = [] ) => ( ids || [] ).some( id => ancestorIds.includes( id ) );
    return ( terms || [] ).filter( term => {
      if ( term.values && term.values.length > 0
        && termsForTaxon( term.values, taxon ).length === 0 ) return false;
      const taxonIds = term.taxon_ids || [];
      const excepted = term.excepted_taxon_ids || [];
      if ( taxonIds.length === 0 && excepted.length === 0 ) return true;
      if ( has( excepted ) ) return false;
      if ( taxonIds.length === 0 ) return true;
      return has( taxonIds );
    } );
  }

  const termById = id => state.terms.find( t => t.id === id );
  const valueById = ( term, id ) => term && term.values.find( v => v.id === id );

  // Decide what happens if we add (attr, value) to observation o.
  function planFor( o, attr, valueId ) {
    const value = valueById( attr, valueId );
    const skip = text => ( { add: false, text } );
    if ( !o.taxon ) return skip( "no taxon" );
    if ( termsForTaxon( [attr], o.taxon ).length === 0 ) return skip( `${attr.label} n/a for taxon` );
    if ( termsForTaxon( [value], o.taxon ).length === 0 ) return skip( `${value.label} n/a for taxon` );
    const existing = ( o.annotations || [] ).filter( a => a.controlled_attribute_id === attr.id );
    if ( existing.some( a => a.controlled_value_id === valueId ) ) return skip( `has ${value.label}` );
    if ( existing.length && !attr.multivalued ) {
      const cur = valueById( attr, existing[0].controlled_value_id );
      return skip( `has ${attr.label}: ${cur ? cur.label : "?"}` );
    }
    if ( existing.length && value.blocking ) return skip( `${value.label} excludes other values` );
    if ( existing.some( a => ( valueById( attr, a.controlled_value_id ) || {} ).blocking ) ) {
      return skip( `has exclusive ${attr.label} value` );
    }
    return { add: true, text: `${attr.label}: ${value.label}` };
  }

  function selectedObs( ) {
    return state.obs.filter( o => state.selected.has( o.id ) );
  }

  function pickedPairs( ) {
    return [...state.picks.entries( )]
      .map( ( [attrId, valueId] ) => ( { attr: termById( attrId ), valueId } ) )
      .filter( p => p.attr && p.valueId );
  }

  // Turn the current page URL into an API observation search query.
  function queryFromLocation( ) {
    const u = new URL( location.href );
    let p = new URLSearchParams( u.search );
    const reserved = ["identify", "map", "export", "upload", "new", "import", "compare", "id_please", "add_from_list"];
    let m = u.pathname.match( /^\/observations\/([A-Za-z][\w-]*)\/?$/ );
    if ( m && !reserved.includes( m[1] ) ) {
      p.set( "user_id", m[1] );
    } else if ( ( m = u.pathname.match( /^\/people\/([A-Za-z][\w-]*)/ ) ) ) {
      p = new URLSearchParams( { user_id: m[1] } );
    } else if ( !u.pathname.startsWith( "/observations" ) ) {
      p = new URLSearchParams( );
    }
    ["subview", "view", "page", "per_page", "utf8", "locale"].forEach( k => p.delete( k ) );
    if ( p.get( "place_id" ) === "any" ) p.delete( "place_id" );
    if ( [...p.keys( )].length === 0 && state.me ) p.set( "user_id", state.me.login );
    return decodeURIComponent( p.toString( ) );
  }

  // ---------------------------------------------------------------- data

  async function ensureSession( ) {
    state.token = await getToken( );
    if ( !state.me ) {
      const r = await api( "GET", "/users/me" );
      state.me = r.results[0];
    }
    if ( state.terms.length === 0 ) {
      const r = await api( "GET", "/controlled_terms", { auth: false } );
      state.terms = r.results;
    }
  }

  async function loadObservations( ) {
    if ( state.loading || state.running ) return;
    state.loading = true;
    state.obs = [];
    state.selected.clear( );
    state.results.clear( );
    state.lastClickedIndex = null;
    renderAll( );
    const limit = Number( ui.limit.value );
    const query = ui.query.value.trim( ).replace( /^\?/, "" );
    try {
      await ensureSession( );
      let page = 1;
      let total = null;
      while ( state.obs.length < limit ) {
        const params = new URLSearchParams( query );
        params.set( "per_page", String( Math.min( MAX_PER_PAGE, limit - state.obs.length ) ) );
        params.set( "page", String( page ) );
        if ( !params.has( "order_by" ) ) params.set( "order_by", "observed_on" );
        setStatus( `Loading page ${page}…` );
        const r = await api( "GET", "/observations", { params } );
        total = r.total_results;
        state.obs.push( ...r.results );
        renderGrid( );
        if ( r.results.length === 0 || state.obs.length >= total ) break;
        page += 1;
        await sleep( 1000 );
      }
      state.obs.forEach( o => state.selected.add( o.id ) );
      setStatus( total > state.obs.length
        ? `Loaded ${state.obs.length} of ${total.toLocaleString( )} matching observations (limit ${limit}).`
        : `Loaded ${state.obs.length} observation${state.obs.length === 1 ? "" : "s"}.` );
    } catch ( e ) {
      setStatus( `Error: ${e.message}`, true );
    } finally {
      state.loading = false;
      renderAll( );
    }
  }

  async function applyAnnotations( ) {
    if ( state.running ) return;
    const pairs = pickedPairs( );
    const targets = selectedObs( );
    const jobs = [];
    targets.forEach( o => pairs.forEach( p => {
      const plan = planFor( o, p.attr, p.valueId );
      if ( plan.add ) jobs.push( { o, ...p } );
    } ) );
    if ( jobs.length === 0 ) return;
    if ( !confirm( `Add ${jobs.length} annotation${jobs.length === 1 ? "" : "s"} to ${new Set( jobs.map( j => j.o.id ) ).size} observation(s)?` ) ) return;

    state.running = true;
    state.stopRequested = false;
    state.results.clear( );
    renderAll( );
    let ok = 0;
    let failed = 0;
    try {
      state.token = await getToken( );
      for ( let i = 0; i < jobs.length; i += 1 ) {
        if ( state.stopRequested ) break;
        const { o, attr, valueId } = jobs[i];
        const value = valueById( attr, valueId );
        // Re-check: an earlier job in this run may have changed the observation.
        const plan = planFor( o, attr, valueId );
        if ( !plan.add ) { addResult( o.id, "skip", plan.text ); continue; }
        setProgress( i, jobs.length, `Adding ${attr.label}: ${value.label} to #${o.id}…` );
        let attempt = 0;
        for ( ;; ) {
          try {
            const r = await api( "POST", "/annotations", {
              body: {
                resource_type: "Observation",
                resource_id: o.id,
                controlled_attribute_id: attr.id,
                controlled_value_id: valueId
              }
            } );
            o.annotations = ( o.annotations || [] ).concat( [{
              uuid: r && r.uuid,
              controlled_attribute_id: attr.id,
              controlled_value_id: valueId,
              user_id: state.me.id
            }] );
            addResult( o.id, "ok", `${attr.label}: ${value.label}` );
            ok += 1;
            break;
          } catch ( e ) {
            if ( e.status === 429 && attempt < 2 ) {
              attempt += 1;
              setProgress( i, jobs.length, "Rate limited by iNaturalist. Waiting 60 s…" );
              await sleep( 60000 );
              continue;
            }
            if ( e.status === 401 && attempt < 1 ) {
              attempt += 1;
              state.token = await getToken( );
              continue;
            }
            addResult( o.id, "err", `${attr.label}: ${e.message}` );
            failed += 1;
            break;
          }
        }
        renderCard( o );
        await sleep( WRITE_DELAY_MS );
      }
      const stopped = state.stopRequested ? " Stopped." : "";
      setProgress( jobs.length, jobs.length,
        `Done. Added ${ok}${failed ? `, failed ${failed}` : ""}.${stopped}` );
    } catch ( e ) {
      setProgress( 0, 1, `Error: ${e.message}` );
    } finally {
      state.running = false;
      renderAll( );
    }
  }

  function addResult( obsId, kind, text ) {
    const list = state.results.get( obsId ) || [];
    list.push( { kind, text } );
    state.results.set( obsId, list );
  }

  // ---------------------------------------------------------------- UI

  const ui = {};

  function buildPanel( ) {
    const host = h( "div", { id: "inat-batch-annotate-host" } );
    const root = host.attachShadow( { mode: "open" } );
    root.append( h( "style", {}, CSS ) );

    ui.query = h( "input", {
      class: "query",
      type: "text",
      spellcheck: "false",
      placeholder: "e.g. user_id=you&taxon_id=47170&quality_grade=research",
      onkeydown: e => { if ( e.key === "Enter" ) loadObservations( ); }
    } );
    ui.limit = h( "select", { title: "Maximum observations to load" },
      [50, 100, 200, 500, 1000, 2000].map( n => h( "option", { value: n, selected: n === 200 }, `max ${n}` ) ) );
    ui.load = h( "button", { class: "primary", onclick: loadObservations }, "Load" );
    ui.status = h( "div", { class: "status" } );
    ui.terms = h( "div", { class: "terms" } );
    ui.summary = h( "div", { class: "summary" } );
    ui.apply = h( "button", { class: "primary", onclick: applyAnnotations }, "Apply" );
    ui.stop = h( "button", { onclick: ( ) => { state.stopRequested = true; } }, "Stop" );
    ui.progressBar = h( "progress", { max: 1, value: 0 } );
    ui.progressText = h( "div", { class: "status" } );
    ui.groups = h( "div", { class: "chips" } );
    ui.count = h( "span", { class: "count" } );
    ui.grid = h( "div", { class: "grid" } );
    ui.cards = new Map( );

    const panel = h( "div", { class: "panel", role: "dialog", "aria-label": "Batch annotate" },
      h( "header", {},
        h( "h2", {}, "Batch annotate" ),
        h( "button", { class: "icon", title: "Close", "aria-label": "Close", onclick: togglePanel }, "×" ) ),
      h( "section", { class: "top" },
        h( "label", { class: "lbl" }, "1. Load observations (iNat search parameters)" ),
        h( "div", { class: "row" }, ui.query ),
        h( "div", { class: "row" },
          h( "button", {
            onclick: ( ) => { ui.query.value = queryFromLocation( ); loadObservations( ); },
            title: "Use the filters of the page you are on"
          }, "Use this page's filters" ),
          ui.limit, ui.load ),
        ui.status,
        h( "label", { class: "lbl" }, "2. Choose annotations to add" ),
        ui.terms,
        ui.summary,
        h( "div", { class: "row" }, ui.apply, ui.stop ),
        ui.progressBar,
        ui.progressText ),
      h( "section", { class: "obs" },
        h( "div", { class: "toolbar" },
          h( "label", { class: "lbl" }, "3. Select observations " ), ui.count,
          h( "span", { class: "spacer" } ),
          h( "button", { class: "small", onclick: ( ) => selectWhere( ( ) => true ) }, "All" ),
          h( "button", { class: "small", onclick: ( ) => selectWhere( ( ) => false ) }, "None" ),
          h( "button", {
            class: "small",
            title: "Select only observations that the chosen annotations will be added to",
            onclick: ( ) => selectWhere( o => pickedPairs( ).some( p => planFor( o, p.attr, p.valueId ).add ) )
          }, "Applicable" ) ),
        ui.groups,
        ui.grid ) );
    root.append( panel );
    document.documentElement.append( host );
    ui.host = host;
  }

  function setStatus( text, isError = false ) {
    ui.status.textContent = text;
    ui.status.classList.toggle( "error", isError );
  }

  function setProgress( done, total, text ) {
    ui.progressBar.max = total || 1;
    ui.progressBar.value = done;
    ui.progressText.textContent = text;
  }

  function selectWhere( fn ) {
    state.selected = new Set( state.obs.filter( fn ).map( o => o.id ) );
    renderAll( );
  }

  function groupKey( o ) {
    return ( o.taxon && o.taxon.iconic_taxon_name ) || "Unknown";
  }

  function renderAll( ) {
    renderTerms( );
    renderGroups( );
    renderGrid( );
    renderSummary( );
    const busy = state.loading || state.running;
    ui.load.disabled = busy;
    ui.query.disabled = busy;
    ui.stop.hidden = !state.running;
    ui.progressBar.hidden = !state.running && !ui.progressText.textContent;
  }

  function renderTerms( ) {
    ui.terms.replaceChildren( );
    const sel = selectedObs( );
    if ( state.terms.length === 0 ) {
      ui.terms.append( h( "div", { class: "muted" }, "Load observations to see annotation choices." ) );
      return;
    }
    if ( sel.length === 0 ) {
      ui.terms.append( h( "div", { class: "muted" }, "Select observations to see annotation choices." ) );
    }
    state.terms.forEach( attr => {
      const applicable = sel.filter( o => termsForTaxon( [attr], o.taxon ).length > 0 );
      const picked = state.picks.get( attr.id );
      if ( applicable.length === 0 && !picked ) return;
      const select = h( "select", {
        disabled: state.running,
        onchange: e => {
          const v = Number( e.target.value );
          if ( v ) state.picks.set( attr.id, v ); else state.picks.delete( attr.id );
          renderAll( );
        }
      }, h( "option", { value: "" }, "— don't change —" ),
      attr.values.map( v => {
        const n = applicable.filter( o => termsForTaxon( [v], o.taxon ).length > 0 ).length;
        return h( "option", { value: v.id, selected: picked === v.id, disabled: n === 0 && picked !== v.id },
          `${v.label}${n < sel.length ? `  (fits ${n})` : ""}` );
      } ) );
      ui.terms.append( h( "div", { class: "term" },
        h( "span", { class: "term-label" }, attr.label,
          attr.multivalued ? h( "span", { class: "muted" }, " · multiple" ) : null ),
        h( "span", { class: "muted" }, `${applicable.length}/${sel.length}` ),
        select ) );
    } );
  }

  function renderSummary( ) {
    const pairs = pickedPairs( );
    const sel = selectedObs( );
    let adds = 0;
    let skips = 0;
    sel.forEach( o => pairs.forEach( p => { if ( planFor( o, p.attr, p.valueId ).add ) adds += 1; else skips += 1; } ) );
    const n = new Set( sel.filter( o => pairs.some( p => planFor( o, p.attr, p.valueId ).add ) ).map( o => o.id ) ).size;
    ui.summary.textContent = pairs.length === 0
      ? ""
      : `Will add ${adds} annotation${adds === 1 ? "" : "s"} to ${n} observation${n === 1 ? "" : "s"}`
        + ( skips ? ` · ${skips} skipped (already set or not applicable)` : "" );
    ui.apply.disabled = state.running || state.loading || adds === 0;
    ui.apply.textContent = adds ? `Apply ${adds}` : "Apply";
  }

  function renderGroups( ) {
    const counts = {};
    state.obs.forEach( o => { counts[groupKey( o )] = ( counts[groupKey( o )] || 0 ) + 1; } );
    ui.groups.replaceChildren( ...Object.entries( counts ).sort( ( a, b ) => b[1] - a[1] ).map( ( [k, n] ) => {
      const nSel = state.obs.filter( o => groupKey( o ) === k && state.selected.has( o.id ) ).length;
      return h( "button", {
        class: `chip${nSel === n ? " on" : nSel ? " part" : ""}`,
        title: "Click: select only this group. Shift-click: add/remove this group.",
        onclick: e => {
          if ( e.shiftKey ) {
            const add = nSel < n;
            state.obs.filter( o => groupKey( o ) === k ).forEach( o => (
              add ? state.selected.add( o.id ) : state.selected.delete( o.id ) ) );
            renderAll( );
          } else {
            selectWhere( o => groupKey( o ) === k );
          }
        }
      }, `${k} ${n}` );
    } ) );
    ui.count.textContent = state.obs.length ? `${state.selected.size}/${state.obs.length} selected` : "";
  }

  function renderGrid( ) {
    const seen = new Set( );
    const frag = [];
    state.obs.forEach( ( o, i ) => {
      let card = ui.cards.get( o.id );
      if ( !card ) {
        card = buildCard( o );
        ui.cards.set( o.id, card );
      }
      card.dataset.index = i;
      seen.add( o.id );
      fillCard( card, o );
      frag.push( card );
    } );
    for ( const id of [...ui.cards.keys( )] ) if ( !seen.has( id ) ) ui.cards.delete( id );
    ui.grid.replaceChildren( ...frag );
    if ( !state.obs.length && !state.loading ) {
      ui.grid.append( h( "div", { class: "muted empty" },
        "No observations loaded. Filter the iNat observations page the way you like, then click “Use this page's filters”." ) );
    }
  }

  function renderCard( o ) {
    const card = ui.cards.get( o.id );
    if ( card ) fillCard( card, o );
  }

  function buildCard( o ) {
    const photo = o.photos && o.photos[0] && o.photos[0].url;
    const name = o.taxon ? ( o.taxon.preferred_common_name || o.taxon.name ) : ( o.species_guess || "Unknown" );
    const sci = o.taxon && o.taxon.preferred_common_name ? o.taxon.name : "";
    const card = h( "div", { class: "card" },
      h( "div", { class: "thumb" },
        photo ? h( "img", { src: photo, alt: "", loading: "lazy" } ) : h( "div", { class: "nophoto" }, o.sounds && o.sounds.length ? "♪" : "?" ),
        h( "input", { type: "checkbox", class: "check", tabindex: -1 } ) ),
      h( "div", { class: "meta" },
        h( "a", {
          href: `https://www.inaturalist.org/observations/${o.id}`,
          target: "_blank",
          rel: "noopener",
          class: "name",
          title: sci ? `${name} (${sci})` : name,
          onclick: e => e.stopPropagation( )
        }, name ),
        h( "div", { class: "muted small" }, [o.observed_on || "no date", o.user && o.user.login].filter( Boolean ).join( " · " ) ),
        h( "div", { class: "annos" } ),
        h( "div", { class: "plan" } ) ) );
    card.addEventListener( "click", e => onCardClick( e, o ) );
    return card;
  }

  function fillCard( card, o ) {
    const on = state.selected.has( o.id );
    card.classList.toggle( "selected", on );
    card.querySelector( ".check" ).checked = on;
    const annos = card.querySelector( ".annos" );
    annos.replaceChildren( ...( o.annotations || [] ).map( a => {
      const t = termById( a.controlled_attribute_id );
      const v = valueById( t, a.controlled_value_id );
      return h( "span", { class: "tag", title: t ? t.label : "" }, v ? v.label : "?" );
    } ) );
    const plan = card.querySelector( ".plan" );
    const results = state.results.get( o.id );
    if ( results ) {
      plan.replaceChildren( ...results.map( r => h( "span", { class: `tag ${r.kind}` },
        ( r.kind === "ok" ? "✓ " : r.kind === "err" ? "✗ " : "– " ) + r.text ) ) );
    } else if ( on ) {
      plan.replaceChildren( ...pickedPairs( ).map( p => {
        const pl = planFor( o, p.attr, p.valueId );
        return h( "span", { class: `tag ${pl.add ? "add" : "skip"}` }, ( pl.add ? "+ " : "– " ) + pl.text );
      } ) );
    } else {
      plan.replaceChildren( );
    }
  }

  function onCardClick( e, o ) {
    if ( state.running ) return;
    const idx = Number( e.currentTarget.dataset.index );
    if ( e.shiftKey && state.lastClickedIndex !== null ) {
      const [a, b] = [Math.min( idx, state.lastClickedIndex ), Math.max( idx, state.lastClickedIndex )];
      const target = !state.selected.has( o.id );
      state.obs.slice( a, b + 1 ).forEach( x => ( target ? state.selected.add( x.id ) : state.selected.delete( x.id ) ) );
    } else if ( state.selected.has( o.id ) ) {
      state.selected.delete( o.id );
    } else {
      state.selected.add( o.id );
    }
    state.lastClickedIndex = idx;
    state.results.clear( );
    renderAll( );
  }

  function togglePanel( ) {
    if ( !ui.host ) buildPanel( );
    state.open = !state.open;
    // Use inline style, not the hidden attribute: ":host { all: initial }" overrides [hidden].
    ui.host.style.display = state.open ? "" : "none";
    if ( state.open ) {
      renderAll( );
      if ( !state.obs.length && !state.loading ) {
        // Fill in the current page's filters and sign in, but let the user press Load.
        ensureSession( ).then( ( ) => {
          if ( !ui.query.value ) ui.query.value = queryFromLocation( );
          setStatus( `Signed in as ${state.me.login}. Edit the query if you like, then press Load.` );
          renderAll( );
        } ).catch( e => setStatus( `Error: ${e.message}`, true ) );
      }
    }
  }

  ext.runtime.onMessage.addListener( msg => {
    if ( msg && msg.type === "inat-batch-annotate:toggle" ) togglePanel( );
  } );

  // ---------------------------------------------------------------- styles

  const CSS = `
:host { all: initial; }
:host([hidden]) { display: none; }
.panel {
  --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d9d9de; --soft: #f3f4f1;
  --accent: #74ac00; --accent-fg: #ffffff; --accent-soft: #eaf3d6;
  --ok: #2e7d32; --ok-soft: #e3f1e4; --err: #c62828; --err-soft: #fbe5e5; --skip-soft: #ececef;
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483000;
  width: min(560px, 100vw); display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border-left: 1px solid var(--line);
  box-shadow: -8px 0 24px rgba(0,0,0,.15);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #1e1e20; --fg: #f2f2f4; --muted: #a1a1a8; --line: #3a3a3e; --soft: #2a2a2d;
    --accent-soft: #33401c; --ok: #81c784; --ok-soft: #1f3321; --err: #ef9a9a; --err-soft: #3d2222; --skip-soft: #2e2e32;
  }
}
header { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
h2 { font-size: 16px; margin: 0; flex: 1; font-weight: 600; }
section.top { padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; max-height: 55vh; overflow: auto; }
section.obs { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.lbl { font-weight: 600; margin-top: 4px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.query { flex: 1; min-width: 0; font: 12px ui-monospace, Menlo, monospace; }
input.query, select { padding: 5px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
button { font: inherit; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--soft); color: var(--fg); cursor: pointer; }
button:hover:not(:disabled) { filter: brightness(.96); }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
button.icon { border: 0; background: none; font-size: 22px; line-height: 1; padding: 0 4px; }
button.small { padding: 2px 8px; font-size: 12px; }
.status { color: var(--muted); min-height: 1em; }
.status.error { color: var(--err); }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.terms { display: flex; flex-direction: column; gap: 4px; }
.term { display: grid; grid-template-columns: 1fr auto 200px; gap: 8px; align-items: center; }
.term select { width: 100%; }
.summary { font-weight: 600; }
progress { width: 100%; }
.toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 14px 4px; }
.toolbar .lbl { margin: 0; }
.spacer { flex: 1; }
.count { color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 14px 8px; }
.chip { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.chip.part { background: var(--accent-soft); }
.grid { flex: 1; overflow: auto; padding: 0 14px 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; align-content: start; grid-auto-rows: max-content; }
.empty { grid-column: 1 / -1; padding: 24px 0; text-align: center; }
.card { border: 2px solid var(--line); border-radius: 8px; overflow: hidden; cursor: pointer; user-select: none; opacity: .55; background: var(--bg); }
.card.selected { border-color: var(--accent); opacity: 1; }
.thumb { position: relative; aspect-ratio: 1; background: var(--soft); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nophoto { display: grid; place-items: center; height: 100%; font-size: 28px; color: var(--muted); }
.check { position: absolute; top: 6px; left: 6px; width: 18px; height: 18px; pointer-events: none; accent-color: var(--accent); }
.meta { padding: 5px 6px 6px; display: flex; flex-direction: column; gap: 2px; }
.name { color: var(--fg); font-weight: 600; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name:hover { text-decoration: underline; }
.annos, .plan { display: flex; flex-wrap: wrap; gap: 3px; }
.tag { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--soft); }
.tag.add, .tag.ok { background: var(--ok-soft); color: var(--ok); }
.tag.skip { background: var(--skip-soft); color: var(--muted); }
.tag.err { background: var(--err-soft); color: var(--err); }
[hidden] { display: none !important; }
`;
} )( );
