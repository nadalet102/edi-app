const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true,limit:'5mb'}));
app.use(express.static(path.join(__dirname,'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? {rejectUnauthorized:false} : false
});

// BC credentials
const BC_TENANT  = process.env.BC_TENANT_ID;
const BC_CLIENT  = process.env.BC_CLIENT_ID;
const BC_SECRET  = process.env.BC_SECRET;

console.log('BC_TENANT:', BC_TENANT);
console.log('BC_CLIENT:', BC_CLIENT);
console.log('BC_SECRET length:', BC_SECRET?.length);
const BC_COMPANY_ID = process.env.BC_COMPANY_ID || ''; // filled after first call
let bcToken = null, bcTokenExp = 0;

async function getBCToken(){
  if(bcToken && Date.now() < bcTokenExp - 60000) return bcToken;
  const body = new URLSearchParams({
    grant_type:'client_credentials', client_id:BC_CLIENT,
    client_secret:BC_SECRET, scope:'https://api.businesscentral.dynamics.com/.default'
  }).toString();
  const data = await new Promise((res,rej)=>{
    const req = https.request({
      hostname:'login.microsoftonline.com',
      path:`/${BC_TENANT}/oauth2/v2.0/token`,
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}
    },r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));});
    req.on('error',rej);req.write(body);req.end();
  });
  if(data.error) throw new Error(data.error_description);
  bcToken = data.access_token;
  bcTokenExp = Date.now() + data.expires_in*1000;
  return bcToken;
}

async function bcGet(path){
  const token = await getBCToken();
  const result = await new Promise((res,rej)=>{
    const req = https.request({
      hostname:'api.businesscentral.dynamics.com',
      path, method:'GET',
      headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}
    },r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));});
    req.on('error',rej);req.end();
  });
  if(result.status!==200) throw new Error('BC '+result.status+': '+result.body.substring(0,200));
  return JSON.parse(result.body);
}

async function bcPost(path, payload){
  const token = await getBCToken();
  const body = JSON.stringify(payload);
  const result = await new Promise((res,rej)=>{
    const req = https.request({
      hostname:'api.businesscentral.dynamics.com',
      path, method:'POST',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    },r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));});
    req.on('error',rej);req.write(body);req.end();
  });
  if(result.status!==200&&result.status!==201) throw new Error('BC '+result.status+': '+result.body.substring(0,300));
  return JSON.parse(result.body);
}

async function initDB(){
  const stmts = [
    `CREATE TABLE IF NOT EXISTS edi_lotes (
      id SERIAL PRIMARY KEY,
      fecha_recepcion TIMESTAMPTZ DEFAULT NOW(),
      proveedor TEXT DEFAULT 'LEROY_MERLIN',
      texto_original TEXT,
      total_pedidos INTEGER DEFAULT 0,
      importados INTEGER DEFAULT 0,
      estado TEXT DEFAULT 'pendiente'
    )`,
    `CREATE TABLE IF NOT EXISTS edi_pedidos (
      id SERIAL PRIMARY KEY,
      lote_id INTEGER REFERENCES edi_lotes(id),
      num_pedido TEXT NOT NULL,
      codigo_tienda TEXT,
      nombre_tienda TEXT,
      ean_tienda TEXT,
      cliente_bc TEXT,
      fecha_entrega DATE,
      total_eur NUMERIC,
      estado TEXT DEFAULT 'pendiente',
      bc_order_id TEXT,
      bc_order_num TEXT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS edi_lineas (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER REFERENCES edi_pedidos(id),
      ref_edi TEXT NOT NULL,
      descripcion TEXT,
      cantidad NUMERIC,
      precio_unidad NUMERIC,
      ref_lm TEXT,
      ref_bc TEXT,
      mapeo_confirmado BOOLEAN DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS edi_mapeos (
      id SERIAL PRIMARY KEY,
      ref_edi TEXT UNIQUE NOT NULL,
      ref_bc TEXT NOT NULL,
      descripcion_edi TEXT,
      descripcion_bc TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS bc_company_cache (
      id SERIAL PRIMARY KEY,
      company_id TEXT,
      company_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ];
  for(const sql of stmts){
    try { await pool.query(sql); } catch(e) { console.warn('initDB:', e.message); }
  }
  console.log('DB ready');
}

// ── PARSE EDI ────────────────────────────────────────────────────────────────
function parseEDI(text){
  // Normalize — handles real newlines, Windows \r\n, and literal \n strings
  text = text.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const pedidos = [];
  // Split by pedido blocks using FIN PEDIDO or the LEROY MERLIN + PEDIDO header pattern
  // We can't split on LEROY MERLIN alone because it appears in billing address too
  // Instead split on the pattern: line starting with LEROY MERLIN followed by PEDIDO XXXXXX
  const blocks = [];
  const lines = text.split('\n');
  let currentBlock = [];
  let inBlock = false;

  for(const line of lines){
    // New pedido starts with "LEROY MERLIN" at start of line AND contains "PEDIDO \d+"
    if(line.match(/^LEROY MERLIN\S*\s+.*PEDIDO\s+\d+/)){
      if(inBlock && currentBlock.length > 0){
        blocks.push(currentBlock.join('\n'));
      }
      currentBlock = [line];
      inBlock = true;
    } else if(inBlock){
      currentBlock.push(line);
      // End of block
      if(line.match(/^-{20,}/) || line.match(/^\*END\*/)){
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
        inBlock = false;
      }
    }
  }
  if(inBlock && currentBlock.length > 0) blocks.push(currentBlock.join('\n'));

  console.log('Blocks found after fix:', blocks.length);

  for(const block of blocks){
    const numMatch = block.match(/PEDIDO N\s+(\d+)/);
    if(!numMatch) continue;
    const num_pedido = numMatch[1];

    // Tienda nombre desde header
    const headerMatch = block.match(/LEROY MERLIN\s+\S*\s+PEDIDO\s+\d+\s+(.+?)\s+EL\s+\d{2}\/\d{2}\/\d{2}/);
    const nombre_tienda = headerMatch ? headerMatch[1].trim() : '';

    // Fecha entrega: entre ** **
    const fechaEntregaMatch = block.match(/ENTREGUE EL \*\*(\d{2})\/(\d{2})\/(\d{2})\*\*/);
    let fecha_entrega = null;
    if(fechaEntregaMatch){
      fecha_entrega = '20'+fechaEntregaMatch[3]+'-'+fechaEntregaMatch[2].padStart(2,'0')+'-'+fechaEntregaMatch[1].padStart(2,'0');
    }

    // EAN tienda → codigo → cliente BC
    const eanMatch = block.match(/EAN TIENDA\s+(\d+)/);
    const ean_tienda = eanMatch ? eanMatch[1] : null;
    const codigo_tienda = ean_tienda ? ean_tienda.substring(9,12) : null;
    const cliente_bc = codigo_tienda ? 'LM'+codigo_tienda : null;

    // Total
    const totalMatch = block.match(/TOTAL GENERAL\s+([\d,\.]+)\s+EUR/);
    const total_eur = totalMatch ? parseFloat(totalMatch[1].replace(',','.')) : null;

    console.log('Block num_pedido:', numMatch[1]);
    console.log('Block length:', block.length);
    console.log('Has REF F:', block.includes('REF F'));
    console.log('Has TOTAL GENERAL:', block.includes('TOTAL GENERAL'));
    console.log('Lines in block:', block.split('\n').length);

    // Lineas: solo procesar las que están después de la cabecera REF F.-EAN
    const lineas = [];
    const lines = block.split('\n');
    let enSeccionLineas = false;
    for(const rawLine of lines){
      const line = rawLine.replace(/\r/g,'').trimEnd();
      // Detectar inicio de sección de productos
      if(line.match(/^REF\s+F/i) || line.match(/^REF\s+DESIGNACION/i)) {
        enSeccionLineas = true;
        continue;
      }
      // Detectar fin de sección
      if(line.match(/TOTAL GENERAL/i) || line.match(/^-{10,}/) || line.match(/^FIN PEDIDO/i)) {
        enSeccionLineas = false;
        continue;
      }
      if(!enSeccionLineas) continue;
      if(!line.trim()) continue;
      
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if(parts.length < 4) continue;
      const ref = parts[0];
      // Skip if not a valid product ref
      if(!ref.match(/^[A-Z0-9][A-Z0-9\-]*$/) || ref.length < 3) continue;
      // Last part must be 8-digit REF_LM
      const lastRaw = parts[parts.length-1];
      const refLm = lastRaw.replace(/\*/g,'').replace(/[^0-9]/g,'').slice(0,8);
      if(refLm.length !== 8) continue;
      const precio = parseFloat(parts[parts.length-2].replace(',','.'));
      const cantidad = parseFloat(parts[parts.length-3].replace(',','.'));
      if(isNaN(cantidad)||isNaN(precio)) continue;
      const descripcion = parts.slice(1, parts.length-3).join(' ');
      lineas.push({ ref_edi:ref, descripcion, cantidad, precio_unidad:precio, ref_lm:refLm });
    }

    if(lineas.length > 0){
      pedidos.push({ num_pedido, nombre_tienda, ean_tienda, codigo_tienda, cliente_bc, fecha_entrega, total_eur, lineas });
    }
  }
  return pedidos;
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

// POST /api/edi/parse — parse EDI text, return preview
app.post('/api/edi/parse', async (req, res) => {
  try {
    const { texto } = req.body;
    if(!texto) return res.status(400).json({error:'No se recibió texto'});
    console.log('EDI texto length:', texto.length);
    console.log('EDI primeros 200:', JSON.stringify(texto.substring(0,200)));
    const pedidos = parseEDI(texto);
    console.log('Pedidos encontrados:', pedidos.length);
    if(!pedidos.length) return res.status(400).json({error:'No se encontraron pedidos en el texto'});

    // Check mapeos for each ref
    let mapeoMap = {};
    try {
      const refs = [...new Set(pedidos.flatMap(p=>p.lineas.map(l=>l.ref_edi)))];
      const mapeos = (await pool.query('SELECT ref_edi,ref_bc,descripcion_bc FROM edi_mapeos WHERE ref_edi=ANY($1)',[refs])).rows;
      mapeos.forEach(m=>mapeoMap[m.ref_edi]=m);
    } catch(dbErr) {
      console.warn('mapeos query error:', dbErr.message);
    }

    // Annotate lines with mapeo status
    pedidos.forEach(p=>{
      p.lineas.forEach(l=>{
        if(mapeoMap[l.ref_edi]){
          l.ref_bc = mapeoMap[l.ref_edi].ref_bc;
          l.descripcion_bc = mapeoMap[l.ref_edi].descripcion_bc;
          l.mapeado = true;
        } else {
          l.mapeado = false;
        }
      });
      p.todas_mapeadas = p.lineas.every(l=>l.mapeado);
    });

    res.json({ pedidos, total: pedidos.length });
  } catch(e) { res.status(500).json({error: e.message || String(e)}); }
});

// GET /api/mapeos — list all mappings
app.get('/api/mapeos', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM edi_mapeos ORDER BY ref_edi')).rows); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// POST /api/mapeos — save a mapping
app.post('/api/mapeos', async (req, res) => {
  const {ref_edi, ref_bc, descripcion_edi, descripcion_bc} = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO edi_mapeos (ref_edi,ref_bc,descripcion_edi,descripcion_bc)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(ref_edi) DO UPDATE SET ref_bc=$2,descripcion_bc=$4
       RETURNING *`,
      [ref_edi,ref_bc,descripcion_edi||null,descripcion_bc||null]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// DELETE /api/mapeos/:id
app.delete('/api/mapeos/:id', async (req, res) => {
  try { await pool.query('DELETE FROM edi_mapeos WHERE id=$1',[req.params.id]); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:e.message}); }
});

// GET /api/bc/company — get company id
app.get('/api/bc/company', async (req, res) => {
  try {
    const cached = (await pool.query('SELECT company_id FROM bc_company_cache LIMIT 1')).rows[0];
    if(cached) return res.json({id:cached.company_id});
    const data = await bcGet(`/v2.0/${BC_TENANT}/production/api/v2.0/companies`);
    const company = data.value[0];
    await pool.query('INSERT INTO bc_company_cache(company_id,company_name) VALUES($1,$2)',[company.id,company.name]);
    res.json({id:company.id});
  } catch(e) { res.status(502).json({error:e.message}); }
});

// GET /api/bc/items/:ref — search item in BC
app.get('/api/bc/items/:ref', async (req, res) => {
  try {
    const comp = (await pool.query('SELECT company_id FROM bc_company_cache LIMIT 1')).rows[0];
    if(!comp) return res.status(400).json({error:'Company no cargada'});
    const data = await bcGet(`/v2.0/${BC_TENANT}/production/api/v2.0/companies(${comp.company_id})/items?$filter=number eq '${encodeURIComponent(req.params.ref)}'&$select=id,number,displayName`);
    res.json(data.value);
  } catch(e) { res.status(502).json({error:e.message}); }
});

// POST /api/bc/crear-pedido — create sales order in BC via Power Automate flow
app.post('/api/bc/crear-pedido', async (req, res) => {
  const { pedido } = req.body;
  const FLOW_URL = process.env.PA_FLOW_URL;
  if(!FLOW_URL) return res.status(500).json({error:'PA_FLOW_URL no configurada'});

  try {
    // Build payload for Power Automate — only lines with a BC mapping
    const lineas = pedido.lineas
      .filter(l => l.ref_bc)
      .map(l => ({
        ref_bc: l.ref_bc,
        cantidad: l.cantidad,
        precio_unidad: l.precio_unidad
      }));

    const payload = {
      num_pedido: pedido.num_pedido,
      cliente_bc: pedido.cliente_bc,
      fecha_entrega: pedido.fecha_entrega,
      lineas
    };

    // Call the Power Automate flow
    const flowUrl = new URL(FLOW_URL);
    const body = JSON.stringify(payload);
    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: flowUrl.hostname,
        path: flowUrl.pathname + flowUrl.search,
        method: 'POST',
        headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
      }, resp => {
        let d=''; resp.on('data',c=>d+=c);
        resp.on('end',()=>resolve({status:resp.statusCode, body:d}));
      });
      r.on('error', reject);
      r.write(body); r.end();
    });

    if(result.status < 200 || result.status >= 300){
      throw new Error('Power Automate respondió '+result.status+': '+result.body.substring(0,300));
    }

    // Save to DB as imported
    try {
      const lote = (await pool.query(
        `INSERT INTO edi_lotes(proveedor,total_pedidos,importados,estado) VALUES('LEROY_MERLIN',1,1,'importado') RETURNING id`
      )).rows[0];
      await pool.query(
        `INSERT INTO edi_pedidos(lote_id,num_pedido,codigo_tienda,nombre_tienda,ean_tienda,cliente_bc,fecha_entrega,total_eur,estado)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'importado')`,
        [lote.id,pedido.num_pedido,pedido.codigo_tienda,pedido.nombre_tienda,pedido.ean_tienda,pedido.cliente_bc,pedido.fecha_entrega,pedido.total_eur]
      );
    } catch(dbErr) { console.warn('DB save error:', dbErr.message); }

    res.json({ok:true, num_pedido:pedido.num_pedido, mensaje:'Pedido enviado a BC vía Power Automate'});
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

// GET /api/historial
app.get('/api/historial', async (req, res) => {
  try {
    const pedidos = (await pool.query(
      'SELECT * FROM edi_pedidos ORDER BY created_at DESC LIMIT 100'
    )).rows;
    res.json(pedidos);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
const PORT = process.env.PORT || 8080;
initDB().then(()=>app.listen(PORT,()=>console.log('EDI server on port '+PORT)));
