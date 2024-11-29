// TODO make this in a separeted functions
// in order to not mix the API with this

import { ArtifactRegistryClient } from '@google-cloud/artifact-registry';
import { Storage } from '@google-cloud/storage';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { customAlphabet } from 'nanoid';
import request from 'request';
import { v4 as uuid } from 'uuid';
import { parse } from 'yaml';
import Errors from './Errors.js';
import { db } from './Firebase.js';
import { getGcpClient, iam } from './GcpApi.js';

// Instantiates a client
const artifactregistryClient = new ArtifactRegistryClient();

const PROJECT_ID = process.env.PROJECT_ID;
const ARCHITECTURES_BUCKET = process.env.ARCHITECTURES_BUCKET;
const SERVICES_ARCHIVE_BUCKET = process.env.SERVICES_ARCHIVE_BUCKET;
const RESOURCES_ARCHIVE_BUCKET = process.env.RESOURCES_ARCHIVE_BUCKET;

const storage = new Storage();
const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 10);

/**
 * 
 * @param {*} param0 
 * @returns 
 */
const updateState = ({ appId, type, key, data, output }) => {
    return db.collection('apps')
        .doc(encodeURIComponent(appId))
        .collection(type)
        .doc(encodeURIComponent(key))
        .set({
            data,
            output,
        });
}

/**
 * 
 * @param {*} artifacts 
 * @returns 
 */
const downloadArtifacts = ({ artifactsFile }) => {
    return storage.bucket(ARCHITECTURES_BUCKET).file(artifactsFile).download().then(str => {
        const artifacts = JSON.parse(str);
        return Promise.all(artifacts.map(({ type, name, url, crc32c }) => {
            let bucket;
            if (type == 'service') bucket = SERVICES_ARCHIVE_BUCKET;
            else if (type == 'resource') bucket = RESOURCES_ARCHIVE_BUCKET;
            else throw Errors.INVALID('Invalid artifact type ' + type);
            const file = storage.bucket(bucket).file(`${name}.zip`);
            return file.exists().then(([exists]) => {
                if (!exists) return uploadFromUrl(file, url);
                return file.getMetadata().then(([metadata]) => {
                    if (metadata.crc32c != crc32c) return uploadFromUrl(file, url, crc32c);
                });
            });
        }));
    });
}


/**
 * 
 * @param {*} param0 
 * @returns 
 */
const getOutputs = ({ appId }) => {
    console.log('APP', encodeURIComponent(appId));
    const appRef = db.collection('apps').doc(encodeURIComponent(appId));
    const getState = type => {
        return appRef.collection(type).get().then(qs => {
            const elements = {};
            qs.forEach(doc => {
                const state = doc.data();
                console.log("state", state)
                const id = decodeURIComponent(doc.id);
                if (type === 'resources') {
                    elements[id] = state.output;
                } else if (type === 'services') {
                    elements[id] = state.output;
                } else if (type === 'layers') {
                    elements[id] = state.output;
                } else if (type === 'accounts') {
                    elements[id] = state.output;
                } else if (type === 'permissions') {
                    elements[id] = state.output;
                }
            });
            console.log("-->", elements)
            return elements;
        });
    }
    return Promise.all(['services', 'layers', 'accounts', 'permissions', 'resources'].map(type => getState(type).then(elements => [type, elements])))
        .then(entries => {
            return Object.fromEntries(entries);
        });
}


const getPlan = ({ planFile }) => {
    return storage.bucket(ARCHITECTURES_BUCKET).file(planFile).download().then(str => {
        const planUnordered = JSON.parse(str);
        const planOrdered = Object.keys(planUnordered).sort().reduce(
            (obj, key) => {
                obj[key] = planUnordered[key];
                return obj;
            },
            {}
        );
        return Object.values(planOrdered);
    });
}

const setStepStarted = ({ appId, deploymentId, stepId }) => {
    return db.collection('apps')
        .doc(encodeURIComponent(appId))
        .collection('deployments')
        .doc(deploymentId).update({
            [`steps.${stepId}.started`]: Date.now(),
        })
}

const setStepFinished = ({ appId, deploymentId, stepId }) => {
    return db.collection('apps')
        .doc(encodeURIComponent(appId))
        .collection('deployments')
        .doc(deploymentId).update({
            [`steps.${stepId}.finished`]: Date.now(),
        })
}

const getServiceDeployYaml = async ({ service }) => {
    const localZipPath = uuid();
    //const localZipPath = path.join(__dirname, localName); // Temporary file for the ZIP
    try {
        // Step 1: Download the ZIP file from the GCS bucket
        await storage.bucket(SERVICES_ARCHIVE_BUCKET).file(`${service}.zip`).download({ destination: localZipPath });

        // Step 2: Extract the specified file from the ZIP archive
        const zip = new AdmZip(localZipPath);
        const targetFile = zip.getEntry('deploy.yaml');

        if (!targetFile) {
            throw new Error(`The file deploy.yaml does not exist in the ZIP archive.`);
        }

        // Step 3: Return the content of the extracted file
        const str = targetFile.getData().toString('utf-8');

        console.log('>>', str);
        // Step 4: parse yaml string to json
        return parse(str);
    } catch (error) {
        console.error(`Error: ${error.message}`);
        return null;
    } finally {
        // Cleanup: Remove the temporary ZIP file
        try {
            await fs.unlink(localZipPath);
            console.log(`Temporary file "${localZipPath}" removed.`);
        } catch (cleanupError) {
            console.warn(`Failed to remove temporary file: ${cleanupError.message}`);
        }
    }
}

/**
 * 
 * @param {*} param0 
 * @returns 
 */
const createAccount = ({ appId, appShortId, deploymentId, resourceId }) => {
    const uid = `${appShortId}-${nanoid()}`;
    return getGcpClient().then(authClient => {
        const request = {
            // Required. The resource name of the project associated with the service.
            name: `projects/${PROJECT_ID}`,
            resource: {
                "accountId": uid,
                "serviceAccount": {
                    "description": `Service Account for the following resource (appId:${appId}, resourceId:${resourceId}).`,
                    "displayName": `Generated Service Account`,
                }
            },
            auth: authClient,
        };
        return iam.projects.serviceAccounts.create(request).then(result => {
            const response = result.data;
            const account = response.email;
            return account;
        });
    });
}

/**
 * 
 * @param {*} blob 
 * @param {*} url 
 * @param {*} crc32 
 * @returns 
 */
// TODO request is deprecated .. need to use native http or maybe fetch ?
const uploadFromUrl = (blob, url, crc32) => {
    return new Promise((resolve, reject) => {
        request.head(url, (err, res, body) => {
            request(url)
                .pipe(blob.createWriteStream())
                .on('close', () => {
                    blob.getMetadata().then(([metadata]) => {
                        if (metadata.crc32 == crc32) resolve();
                        else reject('Crc32 does not match.');
                    });
                });
        });
    });
}


/**
 * List of functions used in the workflow.
 */
const WorkflowFunctions = {
    updateState,
    downloadArtifacts,
    getOutputs,
    getPlan,
    setStepStarted,
    setStepFinished,
    getServiceDeployYaml,
    createAccount,
};

/**
 * 
 * @param {*} functionName 
 * @param {*} payload 
 * @returns 
 */
export const callFunction = (functionName, payload) => {
    const fn = WorkflowFunctions[functionName];
    if (fn) {
        return fn(payload);
    } else {
        throw Errors.NOT_FOUND(`Step ${functionName} not found`);
    }
}