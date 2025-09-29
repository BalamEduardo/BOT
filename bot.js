// Archivo: bot.js

const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');

// --- CONFIGURACIÓN ---
const PORT = 3000;
const EVO_API_URL = 'http://10.8.0.20:8080';
const EVO_API_KEY = '0875B0E3588B-46EE-AE53-0B71EABCC509';
const MALENA_API_URL = 'https://panel.malena.cloud/api/login-pin';
const INSTANCE_NAME = 'BOT'; // Usamos la instancia correcta 'BOT'

const app = express();
app.use(express.json());

const conversationState = {};
const db = new Database('sesiones.db');
console.log('Conexión a la base de datos SQLite exitosa.');

// --- INICIALIZACIÓN DE LA TABLA (NUEVO) ---
// Este bloque de código se asegura de que la tabla 'sesiones' exista.
const crearTabla = `
  CREATE TABLE IF NOT EXISTS sesiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT UNIQUE NOT NULL,
    token TEXT NOT NULL,
    fecha_creacion DATETIME NOT NULL
  );
`;
db.exec(crearTabla);
console.log('Tabla de sesiones asegurada.');
// -----

// --- FUNCIONES DEL BOT ---

function obtenerSesion(telefono) {
  const query = db.prepare('SELECT * FROM sesiones WHERE telefono = ?');
  return query.get(telefono);
}

function esTokenVigente(fechaCreacion) {
  const ahora = new Date();
  const fechaToken = new Date(fechaCreacion);
  const veinticuatroHorasEnMs = 86400000;
  return (ahora - fechaToken) < veinticuatroHorasEnMs;
}

/**
 * Guarda o actualiza una sesión en la base de datos.
 * @param {string} telefono El número de teléfono.
 * @param {string} token El nuevo token.
 */
function guardarSesion(telefono, token) {
  console.log(`Guardando/actualizando sesión para ${telefono}`);
  const ahora = new Date().toISOString();
  const query = db.prepare('INSERT INTO sesiones (telefono, token, fecha_creacion) VALUES (?, ?, ?) ON CONFLICT(telefono) DO UPDATE SET token = excluded.token, fecha_creacion = excluded.fecha_creacion');
  query.run(telefono, token, ahora);
}

async function enviarMensaje(telefono, texto) {
  console.log(`Enviando mensaje a ${telefono}: "${texto}"`);
  try {
    await axios.post(`${EVO_API_URL}/message/sendText/${INSTANCE_NAME}`, {
      number: telefono,
      text: texto
    }, {
      headers: { 'apikey': EVO_API_KEY }
    });
    console.log('✅ Mensaje enviado con éxito.');
  } catch (error) {
    console.error('Error al enviar el mensaje:', JSON.stringify(error.response?.data, null, 2));
  }
}

// --- ENDPOINT DEL WEBHOOK (CORREGIDO) ---

app.post('/webhook', async (req, res) => {
  console.log('---------- ¡Webhook Recibido! ----------');
  const webhookData = req.body.data;
  
  if (webhookData && webhookData.key && webhookData.message && !webhookData.key.fromMe) {
    let telefono = webhookData.key.remoteJid.split('@')[0];
    const mensaje = webhookData.message.conversation;
    console.log(`Mensaje recibido de: ${telefono}, Contenido: ${mensaje}`);
    
    // 1. ¿El bot está esperando el PIN de este usuario?
    if (conversationState[telefono]?.estado === 'AWAITING_PIN') {
      const pinRecibido = mensaje;
      console.log(`PIN recibido: ${pinRecibido}. Validando...`);
      
      try {
        const response = await axios.post(MALENA_API_URL, { pin: pinRecibido });
        const nuevoToken = response.data.token;

        guardarSesion(telefono, nuevoToken);
        await enviarMensaje(telefono, '✅ ¡Autenticación exitosa! Tu sesión durará 24 horas. Ahora puedes enviar tu comando.');
        
        // --- CORRECCIÓN AQUÍ ---
        // Solo borramos el estado si el PIN fue correcto.
        delete conversationState[telefono]; 
        
      } catch (error) {
        console.error('Error al validar el PIN:', error.response?.data);
        await enviarMensaje(telefono, '❌ PIN incorrecto. Por favor, inténtalo de nuevo.');
        // Ya no borramos el estado aquí, para que el bot siga esperando el PIN correcto.
      }
      
    } else {
      // 2. Si no, procesamos el comando
      const sesionUsuario = obtenerSesion(telefono);

      if (sesionUsuario && esTokenVigente(sesionUsuario.fecha_creacion)) {
        console.log('✅ Token vigente. Procesando comando...');
        await enviarMensaje(telefono, `Comando "${mensaje}" recibido. (Lógica de reinicio pendiente).`);
      
      } else {
        // 3. Si no hay sesión o el token expiró, pedimos el PIN
        if (sesionUsuario) console.log('❌ Token caducado.');
        else console.log('No se encontró sesión.');
        
        await enviarMensaje(telefono, 'Hola, para continuar, por favor envía tu PIN de autenticación.');
        conversationState[telefono] = { estado: 'AWAITING_PIN' };
      }
    }
  }

  res.status(200).send('Mensaje recibido');
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`Bot escuchando en http://localhost:${PORT}`);
});