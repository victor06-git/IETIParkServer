const WebSocket = require('ws');
//const { MongoClient } = require('mongodb');
const winston = require('winston');
//const crypto = require('crypto');
require('dotenv').config();

// logger
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: './data/logs/server.log' })
    ],
});

// config
const SERVER_PORT = process.env.SERVER_PORT;

async function iniciarServidor() {
    try {
        // websocket
        const wss = new WebSocket.Server({ port: SERVER_PORT });
        logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

        wss.on('connection', (ws) => {

            logger.info('Nuevo cliente conectado');
            ws.send(JSON.stringify({ msg: 'Conexión aceptada' }));

            const gameId = crypto.randomUUID(); 
            logger.info(`ID de la partida: ${gameId}`);

            // mensajes cliente servidor :)
            ws.on('message', async (data) => {

                // validamos json
                let message;
                try {
                    message = JSON.parse(data);
                } catch (err) {
                    logger.error('JSON inválido');
                    return;
                }

                logger.info(`Mensaje recibido: ${data}`);

                // verif direcciones
                const validDirections = ['UP', 'LEFT', 'RIGHT'];
                if (!validDirections.includes(message.direction)) {
                    logger.warn('Dirección inválida');
                    return;
                }

                // enviar direcciones
                const movementJson = {
                    gameId: gameId,
                    direction: message.direction,
                    timestampClient: message.timestamp,
                    timestampProcessed: Date.now()
                };

                console.log(JSON.stringify(movementJson));

            });

            // cerrar conexión
            ws.on('close', () => {
                logger.info('Conexión cerrada con cliente');

            });

            // error zzz
            ws.on('error', (err) => {
                logger.error(`Error en la conexión con cliente: ${err}`);
            });
        });

    } catch (err) {
        logger.error(`Error al iniciar servidor: ${err.message}`);
    }
}

iniciarServidor();

