// Decoded SVG artwork ownership. Camera updates never rewrite the source.
(() => {
  const replacePaints=(text,paints)=>text.replace(
    /((?:\b(?:fill|stroke)\s*=\s*["']|\b(?:fill|stroke)\s*:\s*))(#[0-9a-f]{6})(?=\s*(?:!important)?[;"'])/gi,
    (all,prefix,hex)=>prefix+(paints.get(hex.toLowerCase())||hex));

  function controller(source, options, env={
    make:()=>document.createElement('img'),
    create:text=>URL.createObjectURL(new Blob([text],{type:'image/svg+xml'})),
    revoke:url=>URL.revokeObjectURL(url)
  }) {
    let generation=0, disposed=false, node=null, appliedSource=null;
    const owned=new Set(), release=url=>{if(owned.delete(url))env.revoke(url);};
    let activeURL=null;
    return {
      get node(){return node;}, get source(){return source;},
      get appliedSource(){return appliedSource;}, get generation(){return generation;},
      async setAppearance(paints) {
        if(disposed)return false;
        const ticket=++generation, text=replacePaints(source,paints), url=env.create(text);
        owned.add(url);
        let next;
        try {
          next=env.make(); next.decoding='async'; next.draggable=false;
          next.alt=`${options.side} ${options.layer}`;
          next.dataset.imageArtwork=''; next.dataset.side=options.side; next.src=url;
          await next.decode();
        }
        catch(error){release(url); if(disposed||ticket!==generation)return false; throw error;}
        if(disposed||ticket!==generation){release(url);return false;}
        const previous=node, previousURL=activeURL;
        node=next; activeURL=url; appliedSource=text;
        if(previous?.isConnected)previous.replaceWith(next);
        else previous?.remove();
        if(previousURL)release(previousURL);
        return true;
      },
      dispose(){
        if(disposed)return;
        disposed=true; generation++; node?.remove(); node=null;
        for(const url of [...owned])release(url);
      }
    };
  }

  globalThis.ImageView={replacePaints,controller};
})();
