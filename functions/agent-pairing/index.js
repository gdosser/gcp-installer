import express from 'express';

const PAIRING_SECRET_KEY = process.env.PAIRING_SECRET_KEY;
const HOST_ID = process.env.HOST_ID;
const HOST_URL = process.env.HOST_URL;

const app = express();

app.get('/', (req, res, next) => {
    const backendPairingSecretKey = req.query.k;
    if (backendPairingSecretKey === PAIRING_SECRET_KEY) {
        res.status(200).json({
            hostId: HOST_ID, // may not unique worldwide
            hostUrl: HOST_URL, // should be unique
            hostCloudProvider: 'gcp',
        });
    } else {
        res.sendStatus(403)
    }
});

export const handle = app;