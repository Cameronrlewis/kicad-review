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
  function reference(change,revision,rows) {
    const uuid=revision==='base'?(change.uuid_before||change.uuid):change.uuid;
    return rows.find(p=>p.uuid===uuid)?.ref||change.ref;
  }
  return {validate,reference};
})();
