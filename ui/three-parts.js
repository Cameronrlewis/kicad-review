window.ThreeParts=(()=>{
  function validate(rows) {
    const fail=()=>{throw Error('Invalid 3D part index')}, ids=new Set(),refs=new Set();
    if(!Array.isArray(rows))return fail();
    return rows.map(p=>{
      if(!p||typeof p.uuid!=='string'||!p.uuid||typeof p.ref!=='string'||!p.ref||
        !['top','bottom'].includes(p.side)||typeof p.hasModel!=='boolean'||
        !(p.reason===null||typeof p.reason==='string')||!Array.isArray(p.box)||
        p.box.length!==6||!p.box.every(Number.isFinite)||
        p.box.slice(0,3).some((v,i)=>v>p.box[i+3])||ids.has(p.uuid)||refs.has(p.ref))return fail();
      ids.add(p.uuid);refs.add(p.ref);return {...p,box:p.box.slice()};
    });
  }
  // Without a part-index UUID match, a renamed footprint's base reference is the Reference change's old value.
  function revisionRef(change,revision) {
    const t=revision==='base'&&change.changes?.find(c=>Array.isArray(c)&&String(c[0]).toLowerCase()==='reference');
    return t&&typeof t[1]==='string'&&t[1]?t[1]:change.ref;
  }
  function reference(change,revision,rows) {
    const uuid=revision==='base'?(change.uuid_before||change.uuid):change.uuid;
    return rows.find(p=>p.uuid===uuid)?.ref||revisionRef(change,revision);
  }
  return {validate,reference,revisionRef};
})();
