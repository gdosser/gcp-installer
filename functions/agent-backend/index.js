import express from 'express';
import { customAlphabet } from 'nanoid';
import { getAppState, getAppStatus, getAppUpdatePlan, getDeployment, putApp } from './App.js';
import { callFunction } from './Workflow.js';

const Envs = {
    DEV: 'DEV',
    PROD: 'PROD',
}

const env = process.env.ENV || Envs.DEV;

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 5);

const app = express();

// Logging middleware
if (env == Envs.DEV) {

}

app.use((req, res, next) => {
    req.id = nanoid();
    console.log('REQUEST', req.id, req.method, req.url, JSON.stringify(req.body));
    next();
});

/**
 * 
 * @param {*} res 
 * @param {*} status 
 * @param {*} json 
 */
const sendResult = (req, res, status, json) => {
    if (env == Envs.DEV && json) console.log('RESPONSE', req.id, JSON.stringify(json));
    res.status(status).json(json);
}

// API accessible by the master server


// change in /apps/:appId
// add the app appId eveywhere


/**
 * 
 */
app.post('/apps/:organization/:appName/plan', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    return getAppStatus(appId)
        .then(result => sendResult(req, res, 200, result))
        .catch(err => next(err));
});

/**
 * 
 */
app.put('/apps/:organization/:appName', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    const { deploymentId, deployedAt, deploymentPoint, plan, artifacts } = req.body;
    return putApp(appId, deploymentId, deployedAt, deploymentPoint, plan, artifacts)
        .then(result => sendResult(req, res, 201, result))
        .catch(err => next(err));
});

/**
 * 
 */
app.get('/apps/:organization/:appName/state', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    return getAppState(appId)
        .then(result => sendResult(req, res, 200, result))
        .catch(err => next(err));
});

/**
 * 
 */
app.get('/apps/:organization/:appName/status', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    return getAppStatus(appId)
        .then(result => sendResult(req, res, 200, result))
        .catch(err => next(err));
});




// get an execution state
app.get('/executions/:executionId', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    const { architecture, artifacts } = req.body;
    return putApp(appId, architecture, artifacts)
        .then(result => sendResult(req, res, 201, result))
        .catch(err => next(err));
});

// cancel an execution
app.delete('/executions/:executionId', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    const { architecture, artifacts } = req.body;
    return putApp(appId, architecture, artifacts)
        .then(result => sendResult(req, res, 201, result))
        .catch(err => next(err));
});

/**
 * 
 */
app.post('/apps/:appId/mask', (req, res, next) => {
    const architecture = req.body;
    return getAppUpdatePlan(req.params.appId, architecture)
        .then(result => sendResult(req, res, 201, result))
        .catch(err => next(err));
});

/**
 * Returns the deployment with the id provided
 * during this the state of all deployments are updated according the workflow state.
 */
app.get('/apps/:organization/:appName/deployments/:deploymentId', (req, res, next) => {
    const appId = `${req.params.organization}/${req.params.appName}`;
    return getDeployment(appId, req.params.deploymentId)
        .then(deployment => sendResult(req, res, 200, deployment))
        .catch(err => next(err));
});


// API accessible internally - ie not described in the openapi.yaml


app.post('/workflow/:functionName', (req, res, next) => {
    return callFunction(req.params.functionName, req.body)
        .then(result => sendResult(req, res, 201, result))
        .catch(err => next(err));
});

/**
 * 
 */
/*app.put('/apps/:appId/deployments/:deploymentId/steps/:stepId', (req, res, next) => {
    return setDeploymentStepState(req.params.appId, req.params.deploymentId, req.params.stepId, req.body.state)
        .then(result => sendResult(req, res, 200, result))
        .catch(err => next(err));
});*/

// Handling 404
app.use((req, res) => {
    res.sendStatus(404);
});

// Handling other errors
app.use((err, req, res, next) => {
    // only display non handled errors
    if (!err.type) console.log(err);
    // create the json response
    var json = {};
    if (err.name) json.name = err.name;
    if (err.message) json.message = err.message;
    // Display the cause only in dev
    if (env == Envs.DEV) {
        if (err.cause) json.cause = err.cause;
        if (err.stack) json.stack = err.stack;
    }
    res.status(err.type || 500).json(json);
});

export const handle = app;