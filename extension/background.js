const ext = globalThis.browser || globalThis.chrome;

ext.action.onClicked.addListener( async tab => {
  if ( !tab || !tab.id ) return;
  const url = tab.url || "";
  if ( !/^https:\/\/(www\.)?inaturalist\.org\//.test( url ) ) {
    // Not on iNaturalist: open it. Click the button again there.
    ext.tabs.create( { url: "https://www.inaturalist.org/observations" } );
    return;
  }
  try {
    await ext.tabs.sendMessage( tab.id, { type: "inat-batch-annotate:toggle" } );
  } catch ( e ) {
    // Content script not loaded yet (e.g. tab opened before the extension was enabled).
    console.warn( "iNat Batch Annotate: reload the page and try again.", e );
  }
} );
