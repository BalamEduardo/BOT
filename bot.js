// Archivo: bot.js
const stringSimilarity = require('string-similarity');
const COMANDOS_VALIDOS = ['!reiniciar'];
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
//cambio
// --- CONFIGURACIÓN ---
const PORT = 3000;
const EVO_API_URL = 'http://10.8.0.20:8080';
const EVO_API_KEY = '429683C4C977415CAAFCCE10F7D57E11';
const MALENA_API_URL = 'https://panel.malena.cloud/api/login-pin';
const MALENA_REBOOT_API_URL = 'https://panel.malena.cloud/api/host/reboot'; 
const INSTANCE_NAME = 'BOT';

const app = express();
app.use(express.json());

const conversationState = {};
const db = new Database('sesiones.db');
console.log('Conexión a la base de datos SQLite exitosa.');

// --- INICIALIZACIÓN DE LA TABLA ---
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

// --- NUEVO --- Función para procesar comandos
async function procesarComando(telefono, token, mensaje) {
  const [comando, ...args] = mensaje.trim().split(/\s+/);

  switch (comando.toLowerCase()) {
    case '!reiniciar':
      const host = args[0];
      if (!host) {
        await enviarMensaje(telefono, '❌ Por favor, especifica el nombre del equipo. Ejemplo: `!reiniciar AD_Hab115`');
        return;
      }

      // --- CORRECCIÓN AQUÍ --- Se elimina el texto "(MODO DE PRUEBA)"
      await enviarMensaje(telefono, `⏳ Procesando orden de reinicio para *${host}*... Un momento.`);

      try {
        const response = await axios.post(MALENA_REBOOT_API_URL, {
          hostname: host
        }, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.data && response.data.success) {
          const mensajeExito = response.data.message || 'El equipo se reinició correctamente.';
          await enviarMensaje(telefono, `✅ ¡Éxito! ${mensajeExito}`);
        } else {
          const mensajeFallo = response.data.message || 'La API reportó un error desconocido.';
          await enviarMensaje(telefono, `🔴 Error al procesar el reinicio: ${mensajeFallo}`);
        }
      } catch (error) {
        console.error('Error al llamar a la API de Malena:', error.response ? error.response.data : error.message);
        await enviarMensaje(telefono, '🔴 Hubo un error de comunicación al intentar reiniciar el equipo. Por favor, contacta a un administrador.');
      }
      break;

    default:
      // --- MEJORA AÑADIDA --- Sugerencia de comandos
      const { bestMatch } = stringSimilarity.findBestMatch(comando.toLowerCase(), COMANDOS_VALIDOS);

      if (bestMatch.rating > 0.7) {
        await enviarMensaje(telefono, `Comando no reconocido. ¿Quizás quisiste decir \`${bestMatch.target}\`?`);
      } else {
        await enviarMensaje(telefono, 'Comando no reconocido. Por ahora, solo puedes usar `!reiniciar <hostname>`.');
      }
      break;
  }
}

// --- ENDPOINT DEL WEBHOOK ---

app.post('/webhook', async (req, res) => {
  console.log('---------- ¡Webhook Recibido! ----------');
  const webhookData = req.body.data;
  
  if (webhookData && webhookData.key && webhookData.message && !webhookData.key.fromMe) {
    let telefono = webhookData.key.remoteJid.split('@')[0];
    const mensaje = webhookData.message.conversation;
    console.log(`Mensaje recibido de: ${telefono}, Contenido: ${mensaje}`);
    
    if (conversationState[telefono]?.estado === 'AWAITING_PIN') {
      const pinRecibido = mensaje;
      console.log(`PIN recibido: ${pinRecibido}. Validando...`);
      
      try {
        const response = await axios.post(MALENA_API_URL, { pin: pinRecibido });
        const nuevoToken = response.data.token;
        guardarSesion(telefono, nuevoToken);
        await enviarMensaje(telefono, '✅ ¡Autenticación exitosa! Tu sesión durará 24 horas. Ahora puedes enviar tu comando.');
        delete conversationState[telefono]; 
      } catch (error) {
        console.error('Error al validar el PIN:', error.response?.data);
        await enviarMensaje(telefono, '❌ PIN incorrecto. Por favor, inténtalo de nuevo.');
      }
      
    } else {
      const sesionUsuario = obtenerSesion(telefono);
      if (sesionUsuario && esTokenVigente(sesionUsuario.fecha_creacion)) {
        console.log('✅ Token vigente. Procesando comando...');
        // --- MODIFICADO --- Llamamos a la nueva función en lugar de enviar un mensaje placeholder.
        await procesarComando(telefono, sesionUsuario.token, mensaje);
      
      } else {
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