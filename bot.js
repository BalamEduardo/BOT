// Archivo: bot.js
const stringSimilarity = require('string-similarity');
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const { SessionsClient } = require('@google-cloud/dialogflow');

// --- CONFIGURACIÓN ---
const PORT = 3000;
const EVO_API_URL = 'http://10.8.0.20:8080';
const EVO_API_KEY = '429683C4C977415CAAFCCE10F7D57E11';
const MALENA_API_URL = 'https://panel.malena.cloud/api/login-pin';
const MALENA_REBOOT_API_URL = 'https://panel.malena.cloud/api/host/reboot';
const INSTANCE_NAME = 'BOT';
const COMANDOS_VALIDOS = ['!reiniciar'];
const projectId = 'soportebot-bmgb'; // Asegúrate de que este ID sea correcto en tu JSON

// --- Constantes de tiempo diferenciadas ---
const MINUTOS_INACTIVIDAD = 5; // Para AWAITING_PIN
const MINUTOS_BLOQUEO = 3;     // Para RATE_LIMITED (Demasiados Intentos)
const MS_INACTIVIDAD = MINUTOS_INACTIVIDAD * 60 * 1000;
const MS_BLOQUEO = MINUTOS_BLOQUEO * 60 * 1000;

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

function formatearTiempoRestante(ms) {
  if (ms <= 0) return 'unos segundos';
  const totalSegundos = Math.ceil(ms / 1000);
  const minutos = Math.floor(totalSegundos / 60);
  const segundos = totalSegundos % 60;
  const partes = [];
  if (minutos > 0) partes.push(`${minutos} min`);
  if (segundos > 0) partes.push(`${segundos} seg`);
  return partes.length ? partes.join(' y ') : '1 segundo';
}

function obtenerSesion(telefono) {
  const query = db.prepare('SELECT * FROM sesiones WHERE telefono = ?');
  return query.get(telefono);
}

function esTokenVigente(fechaCreacion) {
  const ahora = new Date();
  const fechaToken = new Date(fechaCreacion);
  if (isNaN(fechaToken)) return false;
  const veinticuatroHorasEnMs = 86400000;
  return (ahora - fechaToken) < veinticuatroHorasEnMs;
}

function guardarSesion(telefono, token) {
  console.log(`Guardando/actualizando sesión para ${telefono}`);
  const ahora = new Date().toISOString();
  const query = db.prepare(
    'INSERT INTO sesiones (telefono, token, fecha_creacion) VALUES (?, ?, ?) ' +
    'ON CONFLICT(telefono) DO UPDATE SET token = excluded.token, fecha_creacion = excluded.fecha_creacion'
  );
  query.run(telefono, token, ahora);
}

function borrarSesion(telefono) {
  console.log(`Borrando sesión para ${telefono}`);
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(telefono);
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

async function procesarComando(telefono, token, mensaje) {
  if (!mensaje || !mensaje.trim()) return;
  const [comando, ...args] = mensaje.trim().split(/\s+/);

  switch (comando.toLowerCase()) {
    case '!reiniciar': {
      const host = args[0];
      if (!host) {
        await enviarMensaje(telefono, '❌ Por favor, especifica el nombre del equipo. Ejemplo: `!reiniciar AD_Hab115`');
        return;
      }

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

        if (response.data?.success) {
          const mensajeExito = response.data.message || 'El equipo se reinició correctamente.';
          await enviarMensaje(telefono, `✅ ¡Éxito! ${mensajeExito}`);
        } else {
          const mensajeFallo = response.data?.message || 'La API reportó un error desconocido.';
          await enviarMensaje(telefono, `🔴 Error al procesar el reinicio: ${mensajeFallo}`);
        }
      } catch (error) {
        console.error('Error al llamar a la API de Malena:', error.response ? error.response.data : error.message);
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
          await enviarMensaje(telefono, '🔴 Tu sesión ha expirado en el servidor. Por favor, envía `!salir` y vuelve a autenticarte.');
          borrarSesion(telefono);
          delete conversationState[telefono];
        } else {
          await enviarMensaje(telefono, '🔴 Hubo un error de comunicación al intentar reiniciar el equipo. Por favor, contacta a un administrador.');
        }
      }
      break;
    }

    case '!salir':
      console.log(`Cerrando sesión para ${telefono} por comando !salir.`);
      borrarSesion(telefono);
      if (conversationState[telefono]?.timeoutId) {
        clearTimeout(conversationState[telefono].timeoutId);
      }
      delete conversationState[telefono];
      await enviarMensaje(telefono, 'Has cerrado sesión exitosamente. 👋');
      break;

    default:
      // Si llegamos aquí desde la IA, significa que ya intentamos interpretar y falló, o es un comando directo.
      const { bestMatch } = stringSimilarity.findBestMatch(comando.toLowerCase(), COMANDOS_VALIDOS);
      if (bestMatch.rating > 0.7) {
        await enviarMensaje(telefono, `Comando no reconocido. ¿Quizás quisiste decir \`${bestMatch.target}\`?`);
      } else {
        await enviarMensaje(telefono, 'Comando no reconocido. Por ahora, solo puedes usar `!reiniciar <hostname>`.');
      }
      break;
  }
}

async function detectarIntencion(mensaje, sessionId) {
  try {
    const sessionClient = new SessionsClient();
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);

    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: mensaje,
          languageCode: 'es', 
        },
      },
    };

    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    return {
      intent: result.intent ? result.intent.displayName : 'Default Fallback Intent',
      parameters: result.parameters ? result.parameters.fields : {},
      fulfillmentText: result.fulfillmentText || 'No estoy seguro de qué hacer con eso.'
    };

  } catch (error) {
    console.error('ERROR AL LLAMAR A DIALOGFLOW:', error.message);
    return { intent: 'ERROR_DIALOGFLOW', parameters: {} };
  }
}

// --- ENDPOINT DEL WEBHOOK ---
app.post('/webhook', async (req, res) => {
  console.log('---------- ¡Webhook Recibido! ----------');
  const webhookData = req.body?.data;

  if (webhookData?.key && webhookData?.message && !webhookData.key.fromMe) {
    res.status(200).send('Mensaje recibido');

    const telefono = webhookData.key.remoteJid.split('@')[0];
    const mensaje =
      webhookData.message.conversation ||
      webhookData.message.extendedTextMessage?.text ||
      webhookData.message.imageMessage?.caption ||
      '';

    if (!mensaje || !mensaje.trim()) return;

    console.log(`Mensaje recibido de: ${telefono}, Contenido: ${mensaje}`);
    let estadoUsuario = conversationState[telefono];

    // RATE LIMIT
    if (estadoUsuario?.estado === 'RATE_LIMITED') {
      const ahora = Date.now();
      const tiempoRestanteMs = (estadoUsuario.timestamp + MS_BLOQUEO) - ahora;
      const tiempoFormateado = formatearTiempoRestante(tiempoRestanteMs);
      await enviarMensaje(telefono, `Por favor, espere. Aún debe esperar ${tiempoFormateado} para volver a intentarlo.`);
      return;
    }

    // AWAITING_PIN
    if (estadoUsuario?.estado === 'AWAITING_PIN') {
      if (mensaje.toLowerCase() === 'cancelar') {
        console.log(`Usuario ${telefono} canceló la solicitud de PIN.`);
        clearTimeout(estadoUsuario.timeoutId);
        delete conversationState[telefono];
        await enviarMensaje(telefono, 'Solicitud cancelada. Puedes enviar un nuevo comando cuando quieras.');
        return;
      }

      const pinRecibido = mensaje;
      console.log(`PIN recibido: ${pinRecibido}. Validando...`);

      try {
        const response = await axios.post(MALENA_API_URL, { pin: pinRecibido });
        const nuevoToken = response.data.token;
        clearTimeout(estadoUsuario.timeoutId);
        delete conversationState[telefono];
        guardarSesion(telefono, nuevoToken);
        await enviarMensaje(telefono, '✅ ¡Autenticación exitosa! Tu sesión durará 24 horas. ¿En qué te puedo ayudar hoy?');
      } catch (error) {
        console.error('Error al validar el PIN:', error.response?.data);

        if (error.response && error.response.status === 429) {
          console.log(`Rate limit alcanzado para ${telefono}`);
          clearTimeout(estadoUsuario.timeoutId);
          await enviarMensaje(telefono, `⚠️ Has realizado demasiados intentos fallidos. Por favor, inténtalo de nuevo en ${MINUTOS_BLOQUEO} minutos.`);

          if (conversationState[telefono]?.timeoutId) {
            clearTimeout(conversationState[telefono].timeoutId);
          }

          const timeoutBloqueoId = setTimeout(async () => {
            console.log(`Fin del rate-limit para ${telefono}. Solicitando PIN de nuevo.`);
            await enviarMensaje(telefono, 'El tiempo de bloqueo ha terminado. Por favor, ingrese su PIN para continuar.\n\nEscribe *cancelar* para anular esta solicitud.');

            const nuevoTimeoutInactividad = setTimeout(async () => {
              if (conversationState[telefono]?.estado === 'AWAITING_PIN') {
                console.log(`Timeout: Expirando estado AWAITING_PIN (post-bloqueo) para ${telefono}`);
                delete conversationState[telefono];
                await enviarMensaje(telefono, 'Tu solicitud de PIN ha expirado por inactividad. Vuelve a enviar tu comando si deseas continuar.');
              }
            }, MS_INACTIVIDAD);

            conversationState[telefono] = {
              estado: 'AWAITING_PIN',
              timestamp: Date.now(),
              timeoutId: nuevoTimeoutInactividad
            };

          }, MS_BLOQUEO);

          conversationState[telefono] = {
            estado: 'RATE_LIMITED',
            timestamp: Date.now(),
            timeoutId: timeoutBloqueoId
          };
        } else {
          await enviarMensaje(telefono, '❌ PIN incorrecto. Por favor, inténtalo de nuevo (o escribe *cancelar*).');
        }
      }
    } else {
      // --- LOGICA PRINCIPAL (TOKEN) ---
      const sesionUsuario = obtenerSesion(telefono);
      
      if (sesionUsuario && esTokenVigente(sesionUsuario.fecha_creacion)) {
        console.log('✅ Token vigente. Consultando a la IA...');
        
        // --- 1. CONSULTAR INTELIGENCIA ARTIFICIAL (DIALOGFLOW) ---
        const resultadoIA = await detectarIntencion(mensaje, telefono);
        const intencion = resultadoIA.intent;
        console.log(`🧠 Intención detectada: ${intencion}`);

        // --- 2. EJECUTAR ACCIONES BASADAS EN LA INTENCIÓN ---
        if (intencion === 'reiniciar_equipo') {
            // Nota: Debes crear el parámetro 'hostname' en Dialogflow
            const host = resultadoIA.parameters.hostname ? resultadoIA.parameters.hostname.stringValue : null;
            
            if (host) {
                await procesarComando(telefono, sesionUsuario.token, `!reiniciar ${host}`);
            } else {
                await enviarMensaje(telefono, 'Entiendo que quieres reiniciar un equipo, pero no capté cuál. ¿Podrías repetir el nombre del host?');
            }

        } else if (intencion === 'salir_sesion') {
            await procesarComando(telefono, sesionUsuario.token, `!salir`);

        } else if (intencion === 'Default Fallback Intent') {
             // Si la IA no entendió, intentamos procesarlo como comando clásico por si acaso
             // o enviamos la respuesta por defecto de Dialogflow
             if (mensaje.startsWith('!')) {
                 await procesarComando(telefono, sesionUsuario.token, mensaje);
             } else {
                 await enviarMensaje(telefono, resultadoIA.fulfillmentText);
             }
             
        } else {
            // Si es una intención de charla (hola, gracias, etc), enviamos lo que diga Dialogflow
            await enviarMensaje(telefono, resultadoIA.fulfillmentText);
        }

      } else {
        // --- NO HAY SESIÓN O EXPIRÓ ---
        if (sesionUsuario) {
          console.log('❌ Token caducado.');
          borrarSesion(telefono);
        } else {
          console.log('No se encontró sesión.');
        }

        await enviarMensaje(telefono, 'Hola, para continuar, por favor envía tu PIN de autenticación.\n\nEscribe *cancelar* para anular esta solicitud.');

        if (conversationState[telefono]?.timeoutId) {
          clearTimeout(conversationState[telefono].timeoutId);
        }

        const timeoutId = setTimeout(async () => {
          if (conversationState[telefono]?.estado === 'AWAITING_PIN') {
            console.log(`Timeout: Expirando estado AWAITING_PIN para ${telefono}`);
            delete conversationState[telefono];
            await enviarMensaje(telefono, 'Tu solicitud de PIN ha expirado por inactividad. Vuelve a enviar tu comando si deseas continuar.');
          }
        }, MS_INACTIVIDAD);

        conversationState[telefono] = {
          estado: 'AWAITING_PIN',
          timestamp: Date.now(),
          timeoutId
        };
      }
    }
  } else {
    res.status(200).send('Webhook recibido pero ignorado (sin datos o mensaje propio).');
  }
});

app.listen(PORT, () => console.log(`🚀 Bot escuchando en puerto ${PORT}`));