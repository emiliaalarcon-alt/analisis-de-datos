// ═══════════════════════════════════════════════════════════════
//  PORTAL PREUNIVERSITARIO — Backend Railway
//  Guarda y sirve datos del portal de forma acumulativa
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const ADMIN_KEY = process.env.ADMIN_KEY || 'preu2026admin';

function authMiddleware(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'No autorizado' });
  next();
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cargas (
      id SERIAL PRIMARY KEY,
      mes VARCHAR(20) NOT NULL,
      año INTEGER NOT NULL,
      descripcion TEXT,
      creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ensayos (
      id SERIAL PRIMARY KEY,
      carga_id INTEGER REFERENCES cargas(id),
      numero_ensayo INTEGER NOT NULL,
      fecha DATE,
      asignatura VARCHAR(100),
      sede VARCHAR(100),
      alumno_nombre VARCHAR(200),
      puntaje INTEGER,
      creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS asistencia (
      id SERIAL PRIMARY KEY,
      carga_id INTEGER REFERENCES cargas(id),
      fecha DATE,
      sede VARCHAR(100),
      asignatura VARCHAR(100),
      alumno_nombre VARCHAR(200),
      presente BOOLEAN,
      creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profesores (
      id SERIAL PRIMARY KEY,
      carga_id INTEGER REFERENCES cargas(id),
      codigo VARCHAR(20),
      nombre VARCHAR(200),
      sedes TEXT[],
      asignaturas TEXT[],
      creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alertas (
      id SERIAL PRIMARY KEY,
      carga_id INTEGER REFERENCES cargas(id),
      alumno_nombre VARCHAR(200),
      sede VARCHAR(100),
      asignatura VARCHAR(100),
      pct_asistencia FLOAT,
      ausencias INTEGER,
      fechas TEXT[],
      tipo VARCHAR(50),
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Base de datos inicializada');
}

app.get('/api/resumen', async (req, res) => {
  try {
    const [alumnos, ensayosRes, asistRes, alertasRes, profesoresRes] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT alumno_nombre) as total FROM ensayos`),
      pool.query(`SELECT asignatura, AVG(puntaje) as promedio, MAX(puntaje) as maximo, MIN(puntaje) as minimo, COUNT(*) as n FROM ensayos GROUP BY asignatura ORDER BY promedio DESC`),
      pool.query(`SELECT sede, ROUND(AVG(CASE WHEN presente THEN 100 ELSE 0 END)::numeric, 1) as promedio_pct FROM asistencia GROUP BY sede ORDER BY promedio_pct DESC`),
      pool.query(`SELECT COUNT(*) as total FROM alertas WHERE tipo = 'ult2'`),
      pool.query(`SELECT COUNT(DISTINCT nombre) as total FROM profesores`)
    ]);
    res.json({
      alumnos_activos: parseInt(alumnos.rows[0]?.total || 0),
      asistencia_global: asistRes.rows,
      ensayos_por_asig: ensayosRes.rows,
      alertas_activas: parseInt(alertasRes.rows[0]?.total || 0),
      total_profesores: parseInt(profesoresRes.rows[0]?.total || 0)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ensayos', async (req, res) => {
  try {
    const { sede } = req.query;
    const where = sede && sede !== 'TODAS' ? `WHERE e.sede = $1` : '';
    const params = sede && sede !== 'TODAS' ? [sede] : [];
    const result = await pool.query(`SELECT e.asignatura, e.numero_ensayo, COUNT(*) as n, ROUND(AVG(e.puntaje)::numeric) as promedio, MAX(e.puntaje) as maximo, MIN(e.puntaje) as minimo FROM ensayos e ${where} GROUP BY e.asignatura, e.numero_ensayo ORDER BY e.asignatura, e.numero_ensayo`, params);
    res.json({ datos: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/asistencia', async (req, res) => {
  try {
    const sedeDist = await pool.query(`SELECT sede, ROUND(AVG(CASE WHEN presente THEN 100 ELSE 0 END)::numeric, 1) as promedio, COUNT(DISTINCT alumno_nombre) as n_alumnos FROM asistencia GROUP BY sede ORDER BY promedio DESC`);
    res.json({ por_sede: sedeDist.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alertas', async (req, res) => {
  try {
    const ult2 = await pool.query(`SELECT alumno_nombre as nombre, sede, asignatura, pct_asistencia as pct, ausencias as aus FROM alertas WHERE tipo = 'ult2' ORDER BY pct_asistencia ASC`);
    const bajo75 = await pool.query(`SELECT alumno_nombre as nombre, sede, asignatura, pct_asistencia as pct FROM alertas WHERE tipo = 'bajo75' ORDER BY pct_asistencia ASC`);
    res.json({ alertas_ult2: ult2.rows, bajo75: bajo75.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rrhh', async (req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT ON (nombre) codigo, nombre, sedes, asignaturas FROM profesores ORDER BY nombre`);
    res.json({ profesores: result.rows, total: result.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cargas', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM cargas ORDER BY creado_en DESC`);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/subir-todo', authMiddleware, express.json({ limit: '50mb' }), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { mes, año, descripcion, ensayos, asistencia, alertas, rrhh } = req.body;
    const carga = await client.query(`INSERT INTO cargas (mes, año, descripcion) VALUES ($1, $2, $3) RETURNING id`, [mes || 'Sin mes', parseInt(año) || new Date().getFullYear(), descripcion || `Carga ${mes} ${año}`]);
    const cargaId = carga.rows[0].id;
    for (const e of (ensayos || [])) {
      await client.query(`INSERT INTO ensayos (carga_id, numero_ensayo, fecha, asignatura, sede, alumno_nombre, puntaje) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [cargaId, e.ensayo||1, e.fecha||null, e.asignatura, e.sede, e.nombre, e.puntaje]);
    }
    for (const a of (asistencia || [])) {
      await client.query(`INSERT INTO asistencia (carga_id, fecha, sede, asignatura, alumno_nombre, presente) VALUES ($1,$2,$3,$4,$5,$6)`, [cargaId, a.fecha||null, a.sede, a.asignatura, a.nombre, a.presente !== false]);
    }
    for (const a of (alertas || [])) {
      await client.query(`INSERT INTO alertas (carga_id, alumno_nombre, sede, asignatura, pct_asistencia, ausencias, fechas, tipo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [cargaId, a.nombre, a.sede, a.asig||a.asignatura, a.pct, a.aus||a.ausencias, a.fechas||[], a.tipo||'ult2']);
    }
    for (const p of (rrhh || [])) {
      await client.query(`INSERT INTO profesores (carga_id, codigo, nombre, sedes, asignaturas) VALUES ($1,$2,$3,$4,$5)`, [cargaId, p.codigo, p.nombre, p.sedes||[], p.cursos||p.asignaturas||[]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, carga_id: cargaId, insertados: { ensayos: (ensayos||[]).length, asistencia: (asistencia||[]).length, alertas: (alertas||[]).length, rrhh: (rrhh||[]).length } });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.delete('/api/admin/cargas/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query(`DELETE FROM ensayos WHERE carga_id=$1`, [id]);
    await pool.query(`DELETE FROM asistencia WHERE carga_id=$1`, [id]);
    await pool.query(`DELETE FROM alertas WHERE carga_id=$1`, [id]);
    await pool.query(`DELETE FROM profesores WHERE carga_id=$1`, [id]);
    await pool.query(`DELETE FROM cargas WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.get('/', (req, res) => res.json({ api: 'Portal Preuniversitario', version: '1.0' }));

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
}).catch(console.error);
