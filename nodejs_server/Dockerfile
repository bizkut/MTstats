# Use an official Node.js runtime as a parent image, based on Alpine Linux
FROM node:18-alpine AS base

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or npm-shrinkwrap.json)
COPY package*.json ./

# Install production dependencies
# Using --omit=dev which is the standard for npm v7+
# For older npm versions, you might use --production
RUN npm install --omit=dev

# If you had many build steps and wanted a smaller final image,
# you could use a multi-stage build here. For this app, it's simple enough.

# Bundle app source
COPY . .

# Make port 3001 available to the world outside this container
EXPOSE 3001

# Define environment variable (optional, can be overridden)
ENV NODE_ENV production

# Run the app when the container launches
CMD ["node", "server.js"]
