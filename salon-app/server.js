// server.js — API + servidor de la app "Mi Salón"
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // necesario en Render para que las cookies "secure" funcionen
app.use(cors({ credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
  },
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

const nullIfEmpty = (v) => (v === '' || v === undefined ? null : v);

/* ---------------------------------------------------------
   Autenticación (un solo usuario)
--------------------------------------------------------- */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === process.env.SALON_USERNAME;
  const validPass = validUser && process.env.SALON_PASSWORD_HASH
    ? bcrypt.compareSync(password || '', process.env.SALON_PASSWORD_HASH)
    : false;
  if (validUser && validPass) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
  return res.redirect('/login.html');
}

// Todo lo que no sea /login.html, /api/login o /api/me exige haber iniciado sesión
app.use((req, res, next) => {
  const publicPaths = ['/login.html', '/api/login', '/api/me'];
  if (publicPaths.includes(req.path)) return next();
  requireAuth(req, res, next);
});

/* ---------------------------------------------------------
   Arranque: crea las tablas si no existen y siembra datos
   de ejemplo la primera vez (para que no arranque vacío).
--------------------------------------------------------- */
async function init() {
  const fs = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM services');
  if (rows[0].n === 0) {
    await pool.query(
      `INSERT INTO services (name, price, duration) VALUES
       ('Manicura semipermanente', 18, 45),
       ('Pedicura completa', 25, 60),
       ('Uñas acrílicas', 32, 90),
       ('Nail art (por uña)', 2, 10)`
    );
    await pool.query(
      `INSERT INTO inventory (name, qty, min_qty, unit) VALUES
       ('Esmalte semipermanente rojo', 3, 2, 'uds'),
       ('Lima de uñas', 10, 4, 'uds'),
       ('Acetona', 1, 1, 'litros')`
    );
  }
}

/* ---------------------------------------------------------
   Settings
--------------------------------------------------------- */
app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT salon_name AS "salonName", stylist_name AS "stylistName", dedication
     FROM settings WHERE id = 1`
  );
  res.json(rows[0] || { salonName: 'Mi Salón', stylistName: '', dedication: '' });
});

app.put('/api/settings', async (req, res) => {
  const { salonName, stylistName, dedication } = req.body;
  const { rows } = await pool.query(
    `UPDATE settings SET salon_name = $1, stylist_name = $2, dedication = $3
     WHERE id = 1
     RETURNING salon_name AS "salonName", stylist_name AS "stylistName", dedication`,
    [salonName || 'Mi Salón', stylistName || '', dedication || '']
  );
  res.json(rows[0]);
});

/* ---------------------------------------------------------
   Clientas
--------------------------------------------------------- */
app.get('/api/clients', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, phone, notes, instagram, image_url AS "imageUrl", images FROM clients ORDER BY name`
  );
  res.json(rows);
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, notes, instagram, imageUrl, images } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO clients (name, phone, notes, instagram, image_url, images) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id::text AS id, name, phone, notes, instagram, image_url AS "imageUrl", images`,
    [name, phone || '', notes || '', instagram || '', imageUrl || '', JSON.stringify(images || [])]
  );
  res.status(201).json(rows[0]);
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes, instagram, imageUrl, images } = req.body;
  const { rows } = await pool.query(
    `UPDATE clients SET name=$1, phone=$2, notes=$3, instagram=$4, image_url=$5, images=$6::jsonb WHERE id=$7
     RETURNING id::text AS id, name, phone, notes, instagram, image_url AS "imageUrl", images`,
    [name, phone || '', notes || '', instagram || '', imageUrl || '', JSON.stringify(images || []), req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/clients/:id', async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

/* ---------------------------------------------------------
   Servicios
--------------------------------------------------------- */
app.get('/api/services', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, price::float AS price, duration, image_url AS "imageUrl" FROM services ORDER BY name`
  );
  res.json(rows);
});

app.post('/api/services', async (req, res) => {
  const { name, price, duration, imageUrl } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO services (name, price, duration, image_url) VALUES ($1,$2,$3,$4)
     RETURNING id::text AS id, name, price::float AS price, duration, image_url AS "imageUrl"`,
    [name, price || 0, duration || 0, imageUrl || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/services/:id', async (req, res) => {
  const { name, price, duration, imageUrl } = req.body;
  const { rows } = await pool.query(
    `UPDATE services SET name=$1, price=$2, duration=$3, image_url=$4 WHERE id=$5
     RETURNING id::text AS id, name, price::float AS price, duration, image_url AS "imageUrl"`,
    [name, price || 0, duration || 0, imageUrl || '', req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/services/:id', async (req, res) => {
  await pool.query('DELETE FROM services WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

/* ---------------------------------------------------------
   Citas (agenda)
--------------------------------------------------------- */
const APPT_SELECT = `
  SELECT id::text AS id,
         to_char(date, 'YYYY-MM-DD') AS date,
         time,
         COALESCE(client_id::text, '') AS "clientId",
         COALESCE(service_id::text, '') AS "serviceId",
         notes,
         images
  FROM appointments`;

app.get('/api/appointments', async (req, res) => {
  const { rows } = await pool.query(`${APPT_SELECT} ORDER BY date, time`);
  res.json(rows);
});

app.post('/api/appointments', async (req, res) => {
  const { date, time, clientId, serviceId, notes, images } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO appointments (date, time, client_id, service_id, notes, images)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [date, time || '', nullIfEmpty(clientId), nullIfEmpty(serviceId), notes || '', JSON.stringify(images || [])]
  );
  const full = await pool.query(`${APPT_SELECT} WHERE id=$1`, [rows[0].id]);
  res.status(201).json(full.rows[0]);
});

app.put('/api/appointments/:id', async (req, res) => {
  const { date, time, clientId, serviceId, notes, images } = req.body;
  await pool.query(
    `UPDATE appointments SET date=$1, time=$2, client_id=$3, service_id=$4, notes=$5, images=$6::jsonb WHERE id=$7`,
    [date, time || '', nullIfEmpty(clientId), nullIfEmpty(serviceId), notes || '', JSON.stringify(images || []), req.params.id]
  );
  const full = await pool.query(`${APPT_SELECT} WHERE id=$1`, [req.params.id]);
  res.json(full.rows[0]);
});

app.delete('/api/appointments/:id', async (req, res) => {
  await pool.query('DELETE FROM appointments WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

/* ---------------------------------------------------------
   Inventario
--------------------------------------------------------- */
app.get('/api/inventory', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, qty::float AS qty, min_qty::float AS "minQty", unit, image_url AS "imageUrl"
     FROM inventory ORDER BY name`
  );
  res.json(rows);
});

app.post('/api/inventory', async (req, res) => {
  const { name, qty, minQty, unit, imageUrl } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO inventory (name, qty, min_qty, unit, image_url) VALUES ($1,$2,$3,$4,$5)
     RETURNING id::text AS id, name, qty::float AS qty, min_qty::float AS "minQty", unit, image_url AS "imageUrl"`,
    [name, qty || 0, minQty || 0, unit || 'uds', imageUrl || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/inventory/:id', async (req, res) => {
  const { name, qty, minQty, unit, imageUrl } = req.body;
  const { rows } = await pool.query(
    `UPDATE inventory SET name=$1, qty=$2, min_qty=$3, unit=$4, image_url=$5 WHERE id=$6
     RETURNING id::text AS id, name, qty::float AS qty, min_qty::float AS "minQty", unit, image_url AS "imageUrl"`,
    [name, qty || 0, minQty || 0, unit || 'uds', imageUrl || '', req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/inventory/:id', async (req, res) => {
  await pool.query('DELETE FROM inventory WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

/* ---------------------------------------------------------
   Finanzas (transacciones)
--------------------------------------------------------- */
app.get('/api/transactions', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id::text AS id, type, concept, amount::float AS amount, to_char(date,'YYYY-MM-DD') AS date
     FROM transactions ORDER BY date DESC`
  );
  res.json(rows);
});

app.post('/api/transactions', async (req, res) => {
  const { type, concept, amount, date } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO transactions (type, concept, amount, date) VALUES ($1,$2,$3,$4)
     RETURNING id::text AS id, type, concept, amount::float AS amount, to_char(date,'YYYY-MM-DD') AS date`,
    [type, concept || '', amount, date]
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/transactions/:id', async (req, res) => {
  await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

/* ---------------------------------------------------------
   Frontend estático
--------------------------------------------------------- */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => console.log(`Mi Salón corriendo en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('Error al iniciar la base de datos:', err);
    process.exit(1);
  });
