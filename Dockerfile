# Usar una imagen oficial de Node.js como base. Alpine es una versión muy ligera.
FROM node:18-alpine

# Crear y definir el directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copiar los archivos de dependencias. El '*' asegura que tanto package.json como package-lock.json se copien.
COPY package*.json ./

# Instalar las dependencias del proyecto
RUN npm install

# Copiar el resto del código de tu aplicación al directorio de trabajo
COPY . .

# Indicar a Docker que la aplicación se ejecutará en el puerto 3000
EXPOSE 3000

# El comando para iniciar tu bot cuando el contenedor arranque
CMD [ "node", "bot.js" ]