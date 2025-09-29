// Archivo: init-db.js

const Database = require('better-sqlite3');

// Esto crea o abre el archivo de la base de datos 'sesiones.db'
const db = new Database('sesiones.db', { verbose: console.log });

function inicializarDB() {
  console.log('Creando la tabla de sesiones si no existe...');

  // SQL para crear la tabla con los campos que necesitas
  const crearTabla = `
    CREATE TABLE IF NOT EXISTS sesiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      fecha_creacion DATETIME NOT NULL
    );
  `;

  // Ejecuta el comando SQL
  db.exec(crearTabla);
  console.log('¡Tabla de sesiones lista!');
}

// Llama a la función para que se ejecute
inicializarDB();

// Cierra la conexión a la base de datos
db.close();