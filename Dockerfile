# 1. Usar una imagen con una versión más nueva de Node.js (v20)
FROM node:20-alpine

# 2. Instalar herramientas de compilación que 'better-sqlite3' necesita
RUN apk add --no-cache python3 make g++

# Crear y definir el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiar los archivos de dependencias
COPY package*.json ./

# Instalar las dependencias del proyecto
RUN npm install

# Copiar el resto del código de tu aplicación
COPY . .

# Indicar a Docker que la aplicación se ejecutará en el puerto 3000
EXPOSE 3000

# El comando para iniciar tu bot
CMD [ "node", "bot.js" ]