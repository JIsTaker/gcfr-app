const esc = (value) => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const number = (value) => Number(String(value ?? '').replace(',', '.'));
const positive = (value, label, integer = false) => {
  const n = number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000 || (integer && !Number.isInteger(n))) throw new Error(`Enter a valid ${label}.`);
  return n;
};
export function averageWeight(samples) {
  if (!Array.isArray(samples) || samples.length !== 3) throw new Error('Enter the weights of 3 items.');
  return samples.reduce((sum,n)=>sum+positive(n,'sample weight'),0)/3;
}
const nonnegative = (value) => {
  const n=number(value);if(!Number.isInteger(n)||n<0||n>1000000)throw new Error('Enter a valid extra item count.');return n;
};

export function calculateStockCount(details) {
  let amount;
  if (details.area === 'shopfloor') {
    const count = details.layout === 'stack'
      ? details.layers.reduce((sum, layer) => {
        if (!number(layer.across) && !number(layer.deep)) return sum;
        if(layer.enabled===false)return sum;
        return sum + positive(layer.across,'layer width',true) * positive(layer.deep,'layer depth',true);
      }, 0) + nonnegative(details.extra||0)
      : positive(details.count,'item count',true);
    const grams=details.weightSource==='manual'&&details.samples?averageWeight(details.samples):details.unitWeightG;
    amount = details.unit === 'kg' ? count * positive(grams,'unit weight') / 1000 : count;
  } else if(details.kind==='remaining'&&details.unit==='kg'&&details.usedMeasure==='count') {
    const grams=details.weightSource==='manual'?averageWeight(details.samples):positive(details.referenceWeightG,'reference weight');
    amount=positive(details.usedCount,'remaining item count',true)*grams/1000;
  } else if (details.kind === 'remaining' || details.mode === 'manual') {
    amount = positive(details.amount, details.unit === 'kg' ? 'weight' : 'item count', details.unit === 'each');
  } else {
    amount = positive(details.packages,'package count',true) * positive(details.perPackage,'package specification',details.unit === 'each');
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) throw new Error('Enter a quantity greater than zero.');
  return Math.round(amount * 1000000) / 1000000;
}

export function initStockCounts({supabase, getUser, toast, onAreaChange,renderBarcode,openStock}) {
  const host = document.getElementById('stockCounts');
  const state = {area:'backstock',date:today(),rows:[],selection:null,editing:null,pendingId:null,busy:false,epoch:0,revision:0,loadedUser:null};
  host.innerHTML = `
    <section id="countEditor" class="card count-editor hidden" aria-labelledby="countEditorTitle"></section>
    <section class="card count-results">
      <div class="stock-section-head"><h3>Counted stock</h3><input id="countDate" type="date" aria-label="Stock count date" value="${state.date}"></div>
      <p class="muted">Backstock + shopfloor · each scan kept separately</p>
      <div id="countLoadStatus" role="status"></div><div id="countGroups"></div>
      <button id="countAddAnother" type="button" class="secondary full">+ Scan another item</button>
    </section>`;
  const q = (id) => document.getElementById(id);
  q('countAddAnother').onclick=()=>{if(!state.busy)q('stockScanBtn').click();};
  const areaName = (area) => area === 'backstock' ? 'Backstock' : 'Shopfloor';
  const formatted = (n,unit) => `${new Intl.NumberFormat('en-AU',{maximumFractionDigits:unit==='kg'?3:0}).format(n)} ${unit}`;

  function setArea(area) {
    if (state.busy) return;
    state.area = area;
    state.selection = null; state.editing = null; state.pendingId = null;
    q('countEditor').classList.add('hidden');
    document.querySelectorAll('[data-stock-area]').forEach(el => {el.classList.toggle('active',el.dataset.stockArea===area);el.setAttribute('aria-pressed',String(el.dataset.stockArea===area));});
    q('stockScanBtn').textContent = area === 'backstock' ? '▣ Scan crate / carton' : '▣ Scan selling barcode / ticket';
    q('stockAreaHint').textContent = area === 'backstock' ? 'Factory barcode · crates and cartons' : 'Selling barcode or product ticket · count items or layers';
    onAreaChange?.(area);
  }
  document.querySelectorAll('[data-stock-area]').forEach(el => el.onclick = () => setArea(el.dataset.stockArea));

  async function load() {
    const user = getUser(); if (!user) return;
    const epoch = ++state.epoch, date = state.date, revision = state.revision;
    state.loadedUser = user.id;
    q('countLoadStatus').textContent = 'Loading saved counts…';
    try {
      const rows = [];
      for (let from=0;;from+=1000) {
        const {data,error} = await supabase.from('gcfr_stock_counts').select('*').eq('user_id',user.id).eq('count_date',date).order('scanned_at',{ascending:true}).order('id').range(from,from+999);
        if (error) throw error;
        rows.push(...(data||[])); if ((data||[]).length < 1000) break;
      }
      if (epoch !== state.epoch || getUser()?.id !== user.id) return;
      if (revision !== state.revision) {void load();return;}
      state.rows=rows; q('countLoadStatus').textContent=''; renderRows();
    } catch(error) {
      if (epoch !== state.epoch) return;
      q('countLoadStatus').textContent=`Could not load saved counts: ${error.message}`;
      const retry=document.createElement('button');retry.type='button';retry.textContent='Retry';retry.onclick=load;q('countLoadStatus').appendChild(retry);
    }
  }
  q('countDate').onchange = () => {
    if(state.busy){q('countDate').value=state.date;return;}
    if(!q('countDate').value){q('countDate').value=state.date;return;}
    state.date=q('countDate').value;state.selection=null;state.editing=null;state.pendingId=null;
    q('countEditor').classList.add('hidden');state.rows=[];renderRows();void load();
  };

  async function loadHistory() {
    const host=document.getElementById('stockCountHistory');if(!host||!getUser())return;
    const userId=getUser().id;host.textContent='Loading stock history…';
    try{
      const rows=[];
      for(let from=0;;from+=1000){
        const {data,error}=await supabase.from('gcfr_stock_counts').select('*').eq('user_id',userId).order('count_date',{ascending:false}).order('scanned_at',{ascending:true}).order('id').range(from,from+999);
        if(error)throw error;rows.push(...(data||[]));if((data||[]).length<1000)break;
      }
      if(getUser()?.id!==userId)return;host.replaceChildren();
      const dates=new Map();for(const row of rows){if(!dates.has(row.count_date))dates.set(row.count_date,[]);dates.get(row.count_date).push(row);}
      for(const [date,entries] of dates){
        const details=document.createElement('details');details.className='count-history-date';
        const summary=document.createElement('summary');summary.textContent=`${date} · ${entries.length} records`;details.appendChild(summary);
        const content=document.createElement('div');details.appendChild(content);renderRows(content,entries);host.appendChild(details);
      }
      if(!rows.length)host.textContent='No saved stock counts yet.';
    }catch(error){if(getUser()?.id===userId)host.textContent=`Could not load stock history: ${error.message}`;}
  }

  function renderRows(target=q('countGroups'),rows=state.rows) {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.product_code}:${row.unit}`;
      if(!groups.has(key)) groups.set(key,{name:row.product_name,code:row.product_code,unit:row.unit,backstock:0,shopfloor:0,items:0,allItemsKnown:true,estimated:false,rows:[]});
      const group=groups.get(key);group[row.area]+=Number(row.quantity);group.rows.push(row);
      try {
        if(row.unit==='each')group.items+=Number(row.quantity);
        else if(row.area==='shopfloor')group.items+=calculateStockCount({...row.details,unit:'each'});
        else if(row.details.kind==='remaining'&&row.details.usedMeasure==='count')group.items+=Number(row.details.usedCount);
        else if(number(row.details.referenceWeightG)>0){group.items+=Number(row.quantity)*1000/number(row.details.referenceWeightG);group.estimated=true;}
        else group.allItemsKnown=false;
      }catch{group.allItemsKnown=false;}
    }
    target.innerHTML = [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(group=>`<details class="count-group">
      <summary><span><strong>${esc(group.name)}</strong><small>${esc(group.code)} · ${group.rows.length} records</small></span><b>${formatted(group.backstock+group.shopfloor,group.unit)}</b></summary>
      <div class="count-subtotals"><span>Backstock <b>${formatted(group.backstock,group.unit)}</b></span><span>Shopfloor <b>${formatted(group.shopfloor,group.unit)}</b></span></div>
      <button type="button" class="secondary" data-ticket-code="${esc(group.code)}">Show product ticket</button><div class="count-ticket hidden"></div>
      <div class="count-soh">SOH · counted total <strong>${formatted(group.backstock+group.shopfloor,group.unit)}</strong></div>
      ${group.unit==='kg'&&group.allItemsKnown?`<p class="muted">${Math.round(group.items)} items${group.estimated?' (estimated from weight)':''} · ${formatted(group.backstock+group.shopfloor,group.unit)}</p>`:''}
      ${group.rows.map(row=>`<div class="count-record"><div><strong>${areaName(row.area)} · ${formatted(Number(row.quantity),row.unit)}</strong><small>${new Date(row.scanned_at).toLocaleTimeString('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${esc(row.barcode||'Product search')}</small></div><button type="button" class="text-button" data-edit-count="${esc(row.id)}">Edit</button></div>`).join('')}</details>`).join('') || '<div class="empty-state">No counts for this date. Scan backstock or shopfloor stock to begin.</div>';
    target.querySelectorAll('[data-ticket-code]').forEach(button=>button.onclick=async()=>{
      const box=button.nextElementSibling;
      if(!box.classList.contains('hidden')){box.classList.add('hidden');return;}
      box.classList.remove('hidden');box.textContent='Loading ticket…';
      const userId=getUser()?.id;
      try{
        const {data,error}=await supabase.from('product_barcodes').select('barcode').eq('product_code',button.dataset.ticketCode).eq('barcode_type','ticket_barcode').order('barcode');
        if(error)throw error;if(getUser()?.id!==userId)return;box.replaceChildren();
        for(const row of data||[]){const code=String(row.barcode||'');if(!/^[\x20-\x7e]{1,128}$/.test(code))continue;const svg=renderBarcode?.(code);if(svg)box.appendChild(svg);const label=document.createElement('div');label.textContent=code;box.appendChild(label);}
        if(!box.children.length)box.textContent='No product ticket registered yet.';
      }catch(error){box.textContent=error.message;}
    });
    target.querySelectorAll('[data-edit-count]').forEach(button=>button.onclick=async()=>{
      if(state.busy)return;
      const row=rows.find(item=>item.id===button.dataset.editCount);state.date=row.count_date;q('countDate').value=state.date;state.rows=rows;state.editing=row;state.pendingId=row.id;
      state.selection={product:{code:row.product_code,name:row.product_name},profile:{stock_type:row.unit==='kg'?'approx':'each',default_unit_weight_g:row.details.referenceWeightG},barcode:row.barcode,scannedAt:row.scanned_at};
      await openStock?.();renderEditor(row.details);q('countEditor').scrollIntoView({block:'nearest'});
    });
  }

  function layerRow(layer,index) {
    return `<div class="count-layer"><label><input data-layer-enabled type="checkbox" ${layer.enabled!==false?'checked':''}>Layer ${index+1}</label><input data-across aria-label="Layer ${index+1} across" type="number" min="0" step="1" inputmode="numeric" placeholder="Across" value="${esc(layer.across||'')}"><span>×</span><input data-deep aria-label="Layer ${index+1} deep" type="number" min="0" step="1" inputmode="numeric" placeholder="Deep" value="${esc(layer.deep||'')}"><output>0</output></div>`;
  }
  function renderEditor(saved = null) {
    const selection=state.selection;
    if(!selection?.profile)return;
    const pack=selection.pack;
    const details=saved||{area:state.area,unit:selection.profile.stock_type==='each'?'each':'kg',kind:'new',mode:pack?.approx_weight_mode||'each',perPackage:selection.profile.stock_type==='each'?pack?.units_per_package:pack?.fixed_package_weight_kg,packages:1,weightSource:number(selection.profile.default_unit_weight_g)>0?'reference':'manual',referenceWeightG:selection.profile.default_unit_weight_g||null,layout:'count',layers:[{enabled:true},{enabled:false},{enabled:false}]};
    const floor=details.area==='shopfloor',kg=details.unit==='kg';
    q('countEditor').innerHTML=`<div class="stock-section-head"><div><small>${areaName(details.area)}${state.editing?' · Edit record':''}</small><h3 id="countEditorTitle">${esc(selection.product.name)}</h3></div><button id="countCancel" type="button" class="text-button">Close</button></div>
      <form id="countForm" class="stack" novalidate>
      ${floor?`<label>Input method<select id="countLayout"><option value="count">Item count</option><option value="stack">Stack · layers</option></select></label>
        <label id="countDirectWrap">Number of items<input id="countDirect" type="number" inputmode="numeric" min="1" step="1" value="${esc(details.count||'')}"></label>
        <div id="countLayersWrap"><div id="countLayers">${(details.layers||[{enabled:true}]).map(layerRow).join('')}</div><button type="button" id="countAddLayer" class="secondary">+ Add layer</button><label>+ Extra individual items<input id="countExtra" type="number" min="0" step="1" inputmode="numeric" value="${esc(details.extra||0)}"></label><p id="countItemsTotal" class="muted"></p></div>
        ${kg?`<label>Unit weight<select id="countWeightSource"><option value="reference" ${number(details.referenceWeightG)>0?'':'disabled'}>Product reference${number(details.referenceWeightG)>0?' · '+esc(details.referenceWeightG)+' g':' · not registered'}</option><option value="manual">Manual · average of 3 items</option></select></label><div id="countWeightWrap"><div class="count-samples">${[0,1,2].map(i=>`<label>Item ${i+1} (g)<input data-weight-sample type="number" inputmode="decimal" min="0.001" step="any" value="${esc(details.samples?.[i]||details.unitWeightG||'')}"></label>`).join('')}</div><p id="countAverage" class="muted"></p></div>`:''}`
      :`<label>Stock type<select id="countKind"><option value="new">New crate / carton</option><option value="remaining">Remaining stock</option></select></label><div id="countPackageWrap"><p class="muted">${esc(pack?.package_label||selection.barcode||'Package')} · ${details.mode==='manual'?'Enter the weight on this package':formatted(number(details.perPackage)||0,details.unit)+' per package'}</p><label>Number of packages<input id="countPackages" type="number" inputmode="numeric" min="1" step="1" value="${esc(details.packages||1)}"></label></div><label id="countAmountWrap">${kg?'Weight (kg)':'Number of items'}<input id="countAmount" type="number" inputmode="decimal" min="0.001" step="${kg?'any':'1'}" value="${esc(details.amount||'')}"></label>`}
      ${!floor&&kg?`<div id="countUsedWeightOptions"><label>Used stock input<select id="countUsedMeasure"><option value="weight">Total remaining weight (kg)</option><option value="count">Item count × unit weight</option></select></label><div id="countUsedCountWrap"><label>Remaining items<input id="countUsedCount" type="number" min="1" step="1" value="${esc(details.usedCount||'')}"></label><label>Unit weight<select id="countUsedWeightSource"><option value="reference" ${number(details.referenceWeightG)>0?'':'disabled'}>Product reference · ${esc(details.referenceWeightG||'not registered')} g</option><option value="manual">Manual · average of 3 items</option></select></label><div id="countUsedSamples" class="count-samples">${[0,1,2].map(i=>`<label>Item ${i+1} (g)<input data-used-sample type="number" min="0.001" step="any" value="${esc(details.samples?.[i]||'')}"></label>`).join('')}</div></div></div>`:''}
      <div id="countPreview" class="count-preview" role="status"></div><button id="countSave" class="primary full" type="submit">${state.editing?'Save changes':'Submit · add item'}</button></form>`;
    q('countEditor').classList.remove('hidden');
    if(floor) {
      q('countLayout').value=details.layout||'count';
      if(kg)q('countWeightSource').value=details.weightSource||'manual';
      q('countAddLayer').onclick=()=>{const layers=q('countLayers');if(layers.children.length>=30)return;layers.insertAdjacentHTML('beforeend',layerRow({},layers.children.length));update();};
    }else {q('countKind').value=details.kind;if(kg){q('countUsedMeasure').value=details.usedMeasure||'weight';q('countUsedWeightSource').value=details.weightSource||'manual';}}
    function currentDetails() {
      const next={...details};
      if(floor){
        next.layout=q('countLayout').value;next.count=q('countDirect').value;
        next.layers=[...q('countLayers').children].map(el=>({enabled:el.querySelector('[data-layer-enabled]').checked,across:el.querySelector('[data-across]').value,deep:el.querySelector('[data-deep]').value}));next.extra=q('countExtra').value;
        if(kg){next.weightSource=q('countWeightSource').value;next.samples=[...q('countWeightWrap').querySelectorAll('[data-weight-sample]')].map(el=>el.value);next.unitWeightG=next.referenceWeightG;if(next.weightSource==='manual'){try{next.unitWeightG=averageWeight(next.samples);}catch{next.unitWeightG=null;}}}
      }else{next.kind=q('countKind').value;next.packages=q('countPackages').value;next.amount=q('countAmount').value;if(kg){next.usedMeasure=q('countUsedMeasure').value;next.usedCount=q('countUsedCount').value;next.weightSource=q('countUsedWeightSource').value;next.samples=[...q('countUsedSamples').querySelectorAll('[data-used-sample]')].map(el=>el.value);}}
      return next;
    }
    function update(){
      const d=currentDetails();
      if(floor){
        q('countDirectWrap').classList.toggle('hidden',d.layout==='stack');q('countLayersWrap').classList.toggle('hidden',d.layout!=='stack');
        let count=number(d.extra)||0;q('countLayers').querySelectorAll('.count-layer').forEach(el=>{const enabled=el.querySelector('[data-layer-enabled]').checked;el.querySelector('[data-across]').disabled=!enabled;el.querySelector('[data-deep]').disabled=!enabled;const total=enabled?number(el.querySelector('[data-across]').value)*number(el.querySelector('[data-deep]').value):0;el.querySelector('output').textContent=Number.isFinite(total)?String(total):'—';count+=Number.isFinite(total)?total:0;});
        q('countItemsTotal').textContent=`${count} items across all layers`;
        if(kg){q('countWeightWrap').classList.toggle('hidden',d.weightSource==='reference');q('countAverage').textContent=d.unitWeightG?`Average: ${Number(d.unitWeightG).toFixed(2)} g per item`:'Enter all 3 sample weights.';}
      }else{const variable=d.kind==='remaining'||d.mode==='manual';const usedCount=kg&&d.kind==='remaining'&&d.usedMeasure==='count';q('countPackageWrap').classList.toggle('hidden',variable);q('countAmountWrap').classList.toggle('hidden',!variable||usedCount);if(kg){q('countUsedWeightOptions').classList.toggle('hidden',d.kind!=='remaining');q('countUsedCountWrap').classList.toggle('hidden',d.usedMeasure!=='count');q('countUsedSamples').classList.toggle('hidden',d.weightSource==='reference');}}
      try{q('countPreview').textContent=(floor&&kg?`${calculateStockCount({...d,unit:'each'})} items · `:'')+formatted(calculateStockCount(d),d.unit);q('countSave').disabled=state.busy;}
      catch(error){q('countPreview').textContent=error.message;q('countSave').disabled=true;}
    }
    q('countForm').oninput=update;q('countForm').onchange=update;
    q('countForm').onsubmit=async event=>{event.preventDefault();await save(currentDetails());};
    q('countCancel').onclick=()=>{if(!state.busy){state.selection=null;state.editing=null;state.pendingId=null;q('countEditor').classList.add('hidden');}};
    update();
  }

  async function save(details) {
    if(state.busy||!state.selection||!getUser())return;
    let quantity;try{quantity=calculateStockCount(details);}catch(error){toast(error.message);return;}
    const userId=getUser().id,selection=state.selection,edit=state.editing;
    state.pendingId ||= crypto.randomUUID();
    const row={id:state.pendingId,user_id:userId,count_date:edit?.count_date||state.date,product_code:selection.product.code,product_name:selection.product.name,barcode:selection.barcode||null,area:details.area,unit:details.unit,quantity,details,scanned_at:edit?.scanned_at||selection.scannedAt||new Date().toISOString(),updated_at:new Date().toISOString()};
    state.busy=true;q('countSave')&&(q('countSave').disabled=true);
    try{
      const {data,error}=await supabase.from('gcfr_stock_counts').upsert(row,{onConflict:'id'}).select('id');
      if(error)throw error;if(!data?.length)throw new Error('The count was not saved. Retry.');
      if(getUser()?.id!==userId)return;
      ++state.revision;
      const index=state.rows.findIndex(item=>item.id===row.id);if(index<0)state.rows.push(row);else state.rows[index]=row;
      state.pendingId=null;state.editing=null;state.selection=null;q('countEditor').classList.add('hidden');renderRows();toast(edit?'Count updated.':'Added to calculator.');
    }catch(error){if(getUser()?.id===userId)toast(`Not saved: ${error.message}`,6000);}
    finally{state.busy=false;if(getUser()?.id===userId&&q('countSave'))q('countSave').disabled=false;}
  }

  async function select(selection,{auto=false}={}) {
    if(state.busy)return;
    state.selection={...selection,scannedAt:new Date().toISOString()};state.editing=null;state.pendingId=null;
    q('countEditor').classList.add('hidden');
    renderEditor();
    if(auto&&state.area==='backstock'&&selection.pack&&selection.profile){
      const each=selection.profile.stock_type==='each';
      const amount=each?selection.pack.units_per_package:selection.pack.fixed_package_weight_kg;
      if(number(amount)>0&&(each||selection.pack.approx_weight_mode==='fixed')){
        await save({area:'backstock',unit:each?'each':'kg',kind:'new',mode:each?'each':'fixed',perPackage:amount,packages:1});
      }
    }
  }
  function reset(){++state.epoch;state.rows=[];state.selection=null;state.editing=null;state.pendingId=null;state.loadedUser=null;state.date=today();q('countDate').value=state.date;q('countEditor').classList.add('hidden');q('countLoadStatus').textContent='';document.getElementById('stockCountHistory')?.replaceChildren();renderRows();}
  return {select,load,loadHistory,reset,area:()=>state.area,isBusy:()=>state.busy};
}
