FROM node:latest

# Create Directory for the Container
WORKDIR /app

# Define volumes to be mountable
VOLUME /app
VOLUME /app

# Copy package configs into working Directory
COPY ./package.json ./package-lock.json ./tsconfig.json /app

# Install required packages
RUN npm install

# Copy src files into Working Directory
COPY ./src /app/src

# Compile the project
RUN npx tsc

# Runs on container start
CMD node ./dist/index.js