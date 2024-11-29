import { Storage } from '@google-cloud/storage';
import { ExecutionsClient } from '@google-cloud/workflows';
import DeploymentQueue from './DeploymentQueue.js';
import { db } from './Firebase.js';
import { customAlphabet } from 'nanoid';

const AGENT_DEPLOY_APP_WORKFLOW = process.env.AGENT_DEPLOY_APP_WORKFLOW;
const ARCHITECTURES_BUCKET = process.env.ARCHITECTURES_BUCKET; // rename in PLAN_BUCKET? 

const deploymentQueue = new DeploymentQueue();
const executionsClient = new ExecutionsClient();
const storage = new Storage();

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 3);

/*

ARCHITECTURE

{
    "main/ai6xkji9q": {
    "src": "test-747935/main/ai6xkji9q/0ddf04ce93e1f518612052a1a875e1e17ed5311f.zip",
    "service": "functions/gcp/f1ed43e1a1be7a72ab34973f138aff87b0b02585.zip",
    "artifact": {
        "editor": "ide",
        "type": "code",
        "language": "nodejs"
    },
    "dependencies": {},
    "configuration": {
        "resources": "1 / 256M",
        "timeout": 60,
        "minInstance": 0,
        "maxInstance": 10
    },
    "variables": {},
    "layers": {
        "@service/functions": "functions/gcp_layers_nodejs/a71d13e5482bc2079c20e25f7c67e67d8a7a310b.zip"
    }
    }
}
*/

/**
 * 
 */
const Status = {
    DEPLOYED: 'DEPLOYED',
    DEPLOYING: 'DEPLOYING',
    NOT_YET_DEPLOYED: 'NOT_YET_DEPLOYED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN',
}

/**
 * 
 * @returns 
 */
export const generateAppShortId = async (transaction) => {
    let i = 0;
    let result = null;
    while (i++ < 100 && !result) {
        let appShortId = nanoid();
        const ref = db.collection('apps').where('appShortId', '==', appShortId);
        const qs = await transaction.get(ref);
        if (qs.empty) result = appShortId;
    }
    if (!result) throw new Error('Unable to create a app short id.');
    return result;
}

/**
 * 
 * @param {*} appId 
 * @param {*} architecture 
 * @param {*} artifacts
 * @returns 
 */
export const putApp = (appId, deploymentId, deployedAt, deploymentPoint, plan, artifacts) => {
    const appDatabaseId = encodeURIComponent(appId);
    const appRef = db.collection('apps').doc(appDatabaseId);
    const deploymentRef = appRef.collection('deployments').doc(deploymentId);
    let appShortId = null; // get from app or generate if it is a new app
    return db.runTransaction(transaction => {
        return transaction.get(appRef).then(doc => {
            const app = doc.exists ? doc.data() : null;
            // we check that the plan is still valid.
            // if the app has been deployed since the plan has been computed, the plan is not valid anymore.
            if (app && (app.deployedAt !== deploymentPoint)) throw new Error('Plan is not valid anymore, the state has been modified.');
            else if (!app && deploymentPoint) throw new Error('Plan is not valid anymore, the app does not exist.');
            // get the status of the app
            return getAppStatus(appId, transaction).then(status => {
                if (![
                    Status.UNKNOWN,
                    Status.FAILED,
                    Status.DEPLOYED,
                    Status.NOT_YET_DEPLOYED,
                ].includes(status)) {
                    throw new Error(`Unable to deploy the application. The app status is ${status}.`);
                }
            }).then(() => {
                if (!app) {
                    return generateAppShortId(transaction).then(id => {
                        appShortId = id;
                        // generate a unique short id for the app
                        transaction.set(appRef, {
                            appId,
                            appShortId,
                            deploymentId,
                            deployedAt,
                        });
                    });
                } else {
                    appShortId = app.appShortId;
                    return transaction.update(appRef, {
                        deploymentId,
                        deployedAt,
                    });
                }
            }).then(() => {
                transaction.set(deploymentRef, {
                    appId,
                    deploymentId,
                    deploymentPoint,
                    deployedAt,
                    execution: 'CREATING', // will be overrided with the execution name when the workflow starts.
                    plan,
                });
            })
        });
    }).then(() => {
        // from here we have the rights to starts the execution
        const planFile = `${appId}/${deploymentId}/plan.json`;
        const artifactsFile = `${appId}/${deploymentId}/artifacts.json`;
        const bucket = storage.bucket(ARCHITECTURES_BUCKET);
        return Promise.all([
            bucket.file(planFile).save(JSON.stringify(plan, null, 2)),
            bucket.file(artifactsFile).save(JSON.stringify((artifacts || {}), null, 2)),
        ]).then(() => {
            return executionsClient.createExecution({
                parent: AGENT_DEPLOY_APP_WORKFLOW,
                execution: {
                    argument: JSON.stringify({
                        appId,
                        appShortId,
                        deploymentId,
                        planFile,
                        artifactsFile,
                    })
                }
            });
        }).then(([execution]) => {
            return deploymentRef.update({
                execution: execution.name,
            }).then(() => {
                return {};
            });
        });
    });
}

/**
 * 
 * @param {*} appId 
 * @param {*} transaction optional transaction
 * @returns 
 */
export const getAppStatus = (appId, transaction) => {
    const appDatabaseId = encodeURIComponent(appId);
    const appRef = db.collection('apps').doc(appDatabaseId);
    return (transaction ? transaction.get(appRef) : appRef.get()).then(doc => {
        if (!doc.exists) return Status.NOT_YET_DEPLOYED;
        const app = doc.data();
        if (!app.deploymentId) return Status.UNKNOWN;
        const deploymentRef = appRef.collection('deployments').doc(app.deploymentId);
        return (transaction ? transaction.get(deploymentRef) : deploymentRef.get()).then(doc => {
            if (!doc.exists) return Status.UNKNOWN;
            const deployment = doc.data();
            if (deployment.execution === 'CREATING') {
                // execution is being created
                if (!deployment.deployedAt) return Promise.resolve(Status.UNKNOWN);
                // if the workflow is not created 1 min after the initialization
                // we assume the workflow failed to start.
                if (Date.now() - deployment.deployedAt > 60 * 1000) {
                    return Status.FAILED;
                } else {
                    return Status.DEPLOYING;
                }
            } else {
                // get the execution
                return executionsClient.getExecution({
                    name: deployment.execution,
                }).then(([execution]) => {
                    const state = execution.state;
                    if (state === 'ACTIVE') return Status.DEPLOYING;
                    if (state === 'CANCELLED') return Status.CANCELLED;
                    if (state === 'SUCCEEDED') return Status.DEPLOYED;
                    if (state === 'FAILED') return Status.FAILED;
                    return Status.UNKNOWN;
                });
            }
        });
    });
}

/**
 * 
 * @param {*} appId 
 * @returns 
 */
export const getAppState = appId => { // TODO rename in deployedArchitecture ? comme on revoie pas l'url du service par ex ... on ne renvoie que l'archi
    const appDatabaseId = encodeURIComponent(appId);
    const appRef = db.collection('apps').doc(appDatabaseId);
    return db.runTransaction(transaction => {
        const deployedAtPromise = transaction.get(appRef).then(doc => {
            if (!doc.exists) return null;
            const app = doc.data();
            return app.deployedAt;
        });
        const getState = type => {
            return transaction.get(appRef.collection(type)).then(qs => {
                if (qs.empty) return {};
                const elements = {};
                qs.forEach(doc => {
                    const data = doc.data().data;
                    if (type === 'resources') {
                        elements[data.resourceId] = data.resource; 
                    } else if (type === 'services') {
                        elements[data.serviceId] = data.service; 
                    } else if (type === 'layers') {
                        elements[data.layerId] = data.layer; 
                    } else if (type === 'accounts') {
                        elements[data.resourceId] = data.account; 
                    } else if (type === 'permissions') {
                        elements[data.resourceId] = data.permission; 
                    }
                });
                return elements;
            });
        }
        return Promise.all([
            deployedAtPromise,
            Promise.all(['services', 'layers', 'accounts', 'permissions', 'resources'].map(type => getState(type).then(elements => [type, elements])))
        ]).then(([deployedAt, entries]) => {
            return {
                deployedAt,
                architecture: Object.fromEntries(entries)
            }
        });
    });
}

/**
 * Return the update mask between the version provided and the current state
 * @param {*} architecture 
 * @returns 
 */
export const getAppUpdatePlan = architecture => {
    return getAppState().then(state => {
        const step = {
            name: '',
            type: '',
            resourseId: '',
            serviceId: '',
            layerId: '',
            data: '',
        }
        const plan = {
            createServices: [],
            createServiceLayers: [],
            //createAccounts: [],
            createResources: [],
            //createWrapperResources: [],
            createPermissions: [],
            updateResources: [],
            deletePermissions: [],
            //deleteWrapperResources: [],
            deleteResources: [],
            //deleteAccounts: [],
            deleteServiceLayers: [],
            deleteServices: [],
        }
        const fns = [servicesSteps, serviceLayersSteps, /*permissionsSteps, resourcesSteps*/];
        fns.forEach(fn => fn(plan, state, architecture));
        var i = 0;
        const planWithIds = Object.fromEntries(Object.entries(plan).map(([type, arr]) => ([
            type,
            arr.map(obj => ({ id: i++, ...obj }))
        ])));
        // remove empty steps
        return Object.fromEntries(Object.entries(planWithIds).filter(([type, arr]) => arr.length > 0));
    });
}















/**
 * 
 * @param {*} deploymentId 
 * @param {*} stepName 
 * @param {*} state 
 * @returns 
 */
/*export const setDeploymentStepState = (appId, deploymentId, stepName, state) => {
    const stepsRef = db.collection('apps').doc(appId).collection('deployments').doc(deploymentId).collection('steps');
    return stepsRef.doc(stepName).set({
        state,
        [state]: new Date().getTime()
    }, { merge: true });
}*/

/**
 * 
 * @param {*} deploymentId 
 * @returns 
 */
export const getDeployment = (appId, deploymentId) => {
    return deploymentQueue.getDeployment(appId, deploymentId);
}

/**
 * 
 * @param {*} resourceId 
 * @returns 
 */
/*export const createServiceAccount = resourceId => {
    const appRef = db.collection('hosts').doc(HOST_ID);
    const uid = nanoid();
    return getGcpClient().then(authClient => {
        const request = {
            // Required. The resource name of the project associated with the service.
            name: `projects/${PROJECT_ID}`,
            resource: {
                "accountId": uid,
                "serviceAccount": {
                    "description": `Service Account for resource: ${resourceId}`,
                    "displayName": `Generated Service Account ${uid}`,
                }
            },
            auth: authClient,
        };
        return iam.projects.serviceAccounts.create(request).then(result => {
            const response = result.data;
            const account = response.email;
            return appRef.update({ account })
        });
    })
}*/


/**
 * Return the list of added, removed and modified fields between two objects
 * @param {*} currObj 
 * @param {*} newObj 
 * @param {*} parent 
 * @returns 
 */
const computeUpdateMask = (currObj = {}, newObj = {}, parent = null) => {
    let currKeys = Object.keys(currObj);
    let newKeys = Object.keys(newObj);
    var added = [], removed = [], modified = [];
    newKeys.filter(k => !currKeys.includes(k)).forEach(k => added.push(parent ? `${parent}.${k}` : k));
    currKeys.filter(k => !newKeys.includes(k)).forEach(k => removed.push(parent ? `${parent}.${k}` : k));
    newKeys.filter(k => currKeys.includes(k)).forEach(k => {
        var cObj = currObj[k];
        var nObj = newObj[k];
        var isArray = Array.isArray(cObj);
        if (typeof cObj !== 'object' || isArray) {
            if (isArray ? JSON.stringify(cObj) != JSON.stringify(nObj) : cObj !== nObj) {
                modified.push(parent ? `${parent}.${k}` : k);
            }
        } else {
            // only recursive on object
            var updateMask = computeUpdateMask(currObj[k], newObj[k], parent ? `${parent}.${k}` : k);
            added = added.concat(updateMask.added);
            removed = removed.concat(updateMask.removed);
            modified = modified.concat(updateMask.modified);
        }
    });
    return { added, removed, modified };
}

/**
 * 
 * "services": [
 *   "functions:e3f3867065e6e03fe97b66c0980610a023db7568"
 * ],
 * 
 * @param {*} mask 
 * @param {*} architecture 
 * @param {*} stateServices 
 */
const servicesSteps = (mask, state, architecture) => {
    mask.createServices = architecture.services.filter(serviceId => !Object.keys(state.services).includes(serviceId)).map(serviceId => ({ serviceId }));
    mask.deleteServices = Object.keys(state.services).filter(serviceId => !architecture.services.includes(serviceId)).map(serviceId => ({ serviceId }));
}

/**
 * 
 * @param {*} mask 
 * @param {*} architecture 
 * @param {*} stateServiceLayers 
 */
const serviceLayersSteps = (mask, state, architecture) => {
    mask.createServiceLayers = architecture.layers.filter(layerId => !Object.keys(state.layers).includes(layerId)).map(layerId => ({ layerId }));
    mask.deleteServiceLayers = Object.keys(state.layers).filter(layerId => !architecture.layers.includes(layerId)).map(layerId => ({ layerId }));
}

/**
 * 
 * @param {*} mask 
 * @param {*} architecture 
 * @param {*} stateAccounts 
 */
const accountsSteps = (mask, state, architecture) => {
    const stateAccounts = Object.fromEntries(Object.entries(state.accounts).filter(([resourceId, account]) => account.account).map(([resourceId, account]) => [resourceId, account.account]));
    const resourceIds = Object.keys(architecture);
    mask.createAccounts = resourceIds.filter(resourceId => !Object.keys(stateAccounts).includes(resourceId)).map(resourceId => ({ resourceId }));
    mask.deleteAccounts = Object.entries(stateAccounts).filter(([resourceId, account]) => !resourceIds.includes(resourceId)).map(([resourceId, account]) => ({ resourceId, account }));
}

/**
 * 
 * @param {*} mask 
 * @param {*} architecture 
 * @param {*} statePermissions 
 */
const permissionsSteps = (mask, state, architecture) => {
    const statePermissions = {};
    const permissions = {};
    const createPermissions = [];
    const deletePermissions = [];
    // get all permissions from the state
    Object.entries(state.resources).filter(([resourceId, resourceState]) => resourceState.resource?.dependencies).forEach(([resourceId, resourceState]) => {
        Object.values(resourceState.resource.dependencies).forEach(dependency => {
            let role = `${resourceState.resource.service.name}:${resourceId}:${dependency.role}`;
            if (!statePermissions.hasOwnProperty(dependency.resourceId)) statePermissions[dependency.resourceId] = [];
            if (!statePermissions[dependency.resourceId].includes(role)) statePermissions[dependency.resourceId].push(role);
        });
    });
    // get all permissions from the architecture
    Object.entries(architecture).filter(([resourceId, resource]) => resource.dependencies).forEach(([resourceId, resource]) => {
        Object.values(resource.dependencies).forEach(dependency => {
            let role = `${resource.service.name}:${resourceId}:${dependency.role}`;
            if (!permissions.hasOwnProperty(dependency.resourceId)) permissions[dependency.resourceId] = [];
            if (!permissions[dependency.resourceId].includes(role)) permissions[dependency.resourceId].push(role);
        });
    });
    // newly created resources
    Object.keys(permissions).filter(resourceId => !statePermissions.hasOwnProperty(resourceId)).forEach(resourceId => createPermissions.push({
        resourceId,
        permissions: permissions[resourceId].map(p => { const [service, resourceId, role] = p.split(':'); return { service, resourceId, role } })
    }));
    // deleted resources
    Object.keys(statePermissions).filter(resourceId => !permissions.hasOwnProperty(resourceId)).forEach(resourceId => deletePermissions.push({
        resourceId,
        permissions: statePermissions[resourceId].map(p => { const [service, resourceId, role] = p.split(':'); return { service, resourceId, role } })
    }));
    // already deployed resources
    Object.keys(permissions).filter(resourceId => statePermissions.hasOwnProperty(resourceId)).forEach(resourceId => {
        const prev = statePermissions[resourceId];
        const next = permissions[resourceId];
        const added = next.filter(x => !prev.includes(x));
        const removed = prev.filter(x => !next.includes(x));
        if (added.length > 0) {
            createPermissions.push({
                resourceId,
                permissions: [...new Set([...prev, ...added])].map(p => { const [service, resourceId, role] = p.split(':'); return { service, resourceId, role } })
            });
        }
        if (removed.length > 0) {
            deletePermissions.push({
                resourceId,
                permissions: next.map(permission => { const [service, resourceId, role] = permission.split(':'); return { service, resourceId, role } })
            });
        }
    });
    mask.createPermissions = createPermissions;
    mask.deletePermissions = deletePermissions;
}

/**
 * 
 * @param {*} mask 
 * @param {*} architecture 
 * @param {*} stateResources 
 */
const resourcesSteps = (mask, state, architecture) => {
    const stateResources = {};
    const createResources = [];
    const createWrapperResources = [];
    const updateResources = [];
    const deleteResources = [];
    const deleteWrapperResources = [];

    Object.entries(state.resources).forEach(([resourceId, resource]) => {
        if (resource.resource) { // TODO ? this check is still needed ??
            stateResources[resourceId] = resource.resource;
        }
    });
    // added resources
    Object.keys(architecture).filter(resourceId => !stateResources.hasOwnProperty(resourceId)).forEach(resourceId => {
        const resource = architecture[resourceId];
        if (!resource.wrapper) {
            const hasDependencies = Object.keys(resource.dependencies).length > 0;
            var resourceWithoutDependencies = { ...resource };
            if (hasDependencies) resourceWithoutDependencies.dependencies = {};
            createResources.push({ resourceId, resource: resourceWithoutDependencies });
            if (hasDependencies) updateResources.push({ resourceId, resource });
        } else {
            // need to be created after wrapped resources
            createWrapperResources.push({ resourceId, resource });
        }
    });
    // deleted resources
    Object.keys(stateResources).filter(resourceId => !architecture.hasOwnProperty(resourceId)).forEach(resourceId => {
        const resource = stateResources[resourceId];
        if (!resource.wrapper) {
            const hasDependencies = Object.keys(resource.dependencies).length > 0;
            var resourceWithoutDependencies = { ...resource };
            if (hasDependencies) {
                resourceWithoutDependencies.dependencies = {};
                updateResources.push({ resourceId, resource: resourceWithoutDependencies });
            }
            deleteResources.push({ resourceId, resource });
        } else {
            // need to be deleted before wrapped resources
            deleteWrapperResources.push({ resourceId, resource });
        }
    });
    // already deployed resources
    Object.keys(architecture).filter(resourceId => stateResources.hasOwnProperty(resourceId)).forEach(resourceId => {
        // check if there is a change
        const prev = stateResources[resourceId];
        const next = architecture[resourceId];
        const updateMask = computeUpdateMask(prev, next);
        if (updateMask.added.length > 0 || updateMask.removed.length > 0 || updateMask.modified.length > 0) {
            // resource need to be updated
            const resource = architecture[resourceId];
            updateResources.push({ resourceId, resource });
        }
    });
    mask.createResources = createResources;
    mask.createWrapperResources = createWrapperResources;
    mask.updateResources = updateResources;
    mask.deleteWrapperResources = deleteWrapperResources;
    mask.deleteResources = deleteResources;
}