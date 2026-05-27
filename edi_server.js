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
const BC_TENANT  = process.env.BC_TENANT_ID  || 'c13ac4dc-a581-498c-b06a-cbc08d95ccbf';
const BC_CLIENT  = process.env.BC_CLIENT_ID  || 'b57f5ab8-8809-47a1-ac8d-e76cbfd3aac9';
const BC_SECRET  = process.env.BC_SECRET     || 'zjk8Q~4mdaqIzTlNpia3nGSkvsDrlW4wTQODYbf6';
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
  const pedidos = [];
  // Split by pedido blocks
  const blocks = text.split(/(?=LEROY MERLIN)/g).filter(b=>b.includes('PEDIDO N '));

  for(const block of blocks){
    // Numero pedido
    const numMatch = block.match(/PEDIDO N\s+(\d+)/);
    if(!numMatch) continue;
    const num_pedido = numMatch[1];

    // Tienda nombre y fecha
    const headerMatch = block.match(/LEROY MERLIN\s+\S*\s+PEDIDO\s+\d+\s+(.+?)\s+EL\s+(\d{2}\/\d{2}\/\d{2})/);
    const nombre_tienda = headerMatch ? headerMatch[1].trim() : '';
    const fechaRaw = headerMatch ? headerMatch[2] : null;
    let fecha_entrega = null;
    if(fechaRaw){
      const [d,m,y] = fechaRaw.split('/');
      fecha_entrega = '20'+y+'-'+m.padStart(2,'0')+'-'+d.padStart(2,'0');
    }

    // EAN tienda
    const eanMatch = block.match(/EAN TIENDA\s+(\d+)/);
    const ean_tienda = eanMatch ? eanMatch[1] : null;
    // Codigo tienda: posiciones 10-12 del EAN (índices 9,10,11)
    const codigo_tienda = ean_tienda ? ean_tienda.substring(9,12) : null;
    const cliente_bc = codigo_tienda ? 'LM'+codigo_tienda : null;

    // Total
    const totalMatch = block.match(/TOTAL GENERAL\s+([\d,\.]+)\s+EUR/);
    const total_eur = totalMatch ? parseFloat(totalMatch[1].replace(',','.')) : null;

    // Lineas de producto
    const lineas = [];
    // Pattern: REF  DESCRIPCION  CANTIDAD  PRECIO  REF_LM
    const linePattern = /^([A-Z0-9\-]{3,15})\s{2,}(.+?)\s{2,}([\d,\.]+)\s+([\d,\.]+)\s+(\d{8})\s*$/gm;
    let lm;
    while((lm = linePattern.exec(block)) !== null){
      const ref = lm[1].trim();
      // Skip header-like lines
      if(['REF','EAN','LEROY','PEDIDO'].includes(ref)) continue;
      lineas.push({
        ref_edi: ref,
        descripcion: lm[2].trim(),
        cantidad: parseFloat(lm[3].replace(',','.')),
        precio_unidad: parseFloat(lm[4].replace(',','.')),
        ref_lm: lm[5].trim()
      });
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
    const pedidos = parseEDI(texto);
    if(!pedidos.length) return res.status(400).json({error:'No se encontraron pedidos en el texto'});

    // Check mapeos for each ref
    const refs = [...new Set(pedidos.flatMap(p=>p.lineas.map(l=>l.ref_edi)))];
    const mapeos = (await pool.query('SELECT ref_edi,ref_bc,descripcion_bc FROM edi_mapeos WHERE ref_edi=ANY($1)',[refs])).rows;
    const mapeoMap = {};
    mapeos.forEach(m=>mapeoMap[m.ref_edi]=m);

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
  } catch(e) { res.status(500).json({error:e.message}); }
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

// POST /api/bc/crear-pedido — create sales order in BC
app.post('/api/bc/crear-pedido', async (req, res) => {
  const { pedido } = req.body;
  try {
    const comp = (await pool.query('SELECT company_id FROM bc_company_cache LIMIT 1')).rows[0];
    if(!comp) return res.status(400).json({error:'Ejecuta primero /api/bc/company'});

    const base = `/v2.0/${BC_TENANT}/production/api/v2.0/companies(${comp.company_id})`;

    // Create sales order
    const order = await bcPost(`${base}/salesOrders`, {
      customerNumber: pedido.cliente_bc,
      requestedDeliveryDate: pedido.fecha_entrega,
      externalDocumentNumber: pedido.num_pedido,
    });

    // Add lines
    for(const linea of pedido.lineas){
      if(!linea.ref_bc) continue;
      await bcPost(`${base}/salesOrders(${order.id})/salesOrderLines`, {
        lineType: 'Item',
        itemNumber: linea.ref_bc,
        quantity: linea.cantidad,
        unitPrice: linea.precio_unidad
      });
    }

    // Save lote/pedido to DB
    const lote = (await pool.query(
      `INSERT INTO edi_lotes(proveedor,total_pedidos,importados,estado) VALUES('LEROY_MERLIN',1,1,'importado') RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO edi_pedidos(lote_id,num_pedido,codigo_tienda,nombre_tienda,ean_tienda,cliente_bc,fecha_entrega,total_eur,estado,bc_order_id,bc_order_num)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'importado',$9,$10)`,
      [lote.id,pedido.num_pedido,pedido.codigo_tienda,pedido.nombre_tienda,pedido.ean_tienda,pedido.cliente_bc,pedido.fecha_entrega,pedido.total_eur,order.id,order.number]
    );

    res.json({ok:true, bc_order_num:order.number, bc_order_id:order.id});
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
const PORT = process.env.PORT || 3000;
initDB().then(()=>app.listen(PORT,()=>console.log('EDI server on port '+PORT)));
