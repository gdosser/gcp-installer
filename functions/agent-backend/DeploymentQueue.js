import { ExecutionsClient } from '@google-cloud/workflows';
import { FieldValue } from 'firebase-admin/firestore';
import { v4 as uuid } from 'uuid';
import { db } from './Firebase.js';

const AGENT_DEPLOY_APP_WORKFLOW = process.env.AGENT_DEPLOY_APP_WORKFLOW;

const executionsClient = new ExecutionsClient();

export const State = {
    // the GCP Workflow
    Execution: {
        STATE_UNSPECIFIED: 'STATE_UNSPECIFIED', //	Invalid state.
        ACTIVE: 'ACTIVE', //	The execution is in progress.
        SUCCEEDED: 'SUCCEEDED', //	The execution finished successfully.
        FAILED: 'FAILED', //	The execution failed with an error.
        CANCELLED: 'CANCELLED', //	The execution was stopped intentionally.
    },
    // the deployment that wrap the execution
    Deployment: {
        PENDING: 'PENDING',
        DEPLOYING: 'DEPLOYING',
        DEPLOYED: 'DEPLOYED',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
        SKIPPED: 'SKIPPED'
    },
    // the entity. an entity can have multiple deployments 
    App: {
        CREATED: 'CREATED',
        DEPLOYING: 'DEPLOYING',
        DEPLOYED: 'DEPLOYED',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
    }
}

/**
 * 
 */
class DeploymentQueue {

    /**
     * 
     */
    constructor() { }

    /**
     * Deploy a new architecture.
     * @param {*} appId the appId = package
     * @param {*} architectureFile the architecture to deploy
     * @param {*} artifactsFile list of artifact to download ASAP
     * @returns 
     */
    putDeployment = (appId, architectureFile, artifactsFile) => {
        return this.createAppIfNotExists(appId).then(() => {
            // create the deployment id
            const deploymentId = uuid();
            // create the firestore document and return it
            const timestamp = new Date().getTime();
            var deployment = {
                deploymentId,
                appId,
                createdAt: timestamp,
                checkedAt: timestamp,
                state: State.Deployment.PENDING,
                architectureFile, // the architecture to deploy !
                artifactsFile, // the artifact to download
            }
            const appDatabaseId = encodeURIComponent(appId);
            const appRef = db.collection('apps').doc(appDatabaseId);
            const deploymentRef = appRef.collection('deployments').doc(deploymentId);
            return deploymentRef.set(deployment).then(() => {
                return executionsClient.createExecution({
                    parent: AGENT_DEPLOY_APP_WORKFLOW,
                    execution: {
                        argument: JSON.stringify({
                            appId,
                            deploymentId,
                            architectureFile,
                            artifactsFile,
                        })
                    }
                });
            }).then(([execution]) => {
                deployment.execution = execution.name;
                return deploymentRef.update({
                    execution: execution.name
                });
            }).then(() => deployment);
        });
    }

    /**
     * Get a deployment.
     * The status of the deployment is checked.
     * For instance, if the deployment is PENDING and no others deployments have been created before,
     * the deployment is set to DEPLOYING.
     * @param {*} appId
     * @param {*} deploymentId 
     * @returns 
     */
    getDeployment = (appId, deploymentId) => {
        return this.updateRunningDeployments(appId) // update the status of all deploying deployments
            .then(() => {
                return this.updateDeployingApp(appId); // update packages, set the state according the state of the deployments
            }).then(() => {
                return this.checkPendingDeployment(appId, deploymentId); // update the status only if this deployment is PENDING
            }).then(() => {
                const appDatabaseId = encodeURIComponent(appId);
                const appRef = db.collection('apps').doc(appDatabaseId);
                return appRef.collection('deployments').doc(deploymentId).get().then(doc => {
                    if (!doc.exists) return "Document does not exist";
                    return doc.data();
                });
            });
    }

    /**
     * 
     * @returns 
     */
    createAppIfNotExists = appId => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        return appRef.get().then(doc => {
            if (doc.exists) {
                return;
            } else {
                const timestamp = new Date().getTime();
                return appRef.set({
                    state: State.App.CREATED,
                    createdAt: timestamp
                });
            }
        });
    }

    /**
     * 
     * @param {*} appId 
     * @returns 
     */
    getApp = appId => {
        return this.updateRunningDeployments(appId) // update all deployments status (check the execution)
            .then(() => {
                return this.updateDeployingApp(appId); // update the current package (check the status of the current deploying deployment)
            }).then(() => {
                const appDatabaseId = encodeURIComponent(appId);
                const appRef = db.collection('apps').doc(appDatabaseId);
                return appRef.get().then(doc => {
                    if (!doc.exists) return null;
                    return doc.data();
                });
            });
    }

    /**
     * 
     * @returns 
     */
    /*putApp = () => {
        return this.appRef.get().then(doc => {
            if (doc.exists) {
                return;
            } else {
                return this.appRef.set({
                    state: State.App.CREATED,
                    createdAt: new Date().getTime()
                });
            }
        });
    }*/



    /**
     * 
     * @param {*} appId 
     * @returns 
     */
    getRunningDeployments = appId => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        return appRef.collection('deployments')
            // we need to check pending deployments too if the next deployment is in a PENDING state and the workflow failed, it will never goes to the state FAILED
            .where('state', 'in', [State.Deployment.DEPLOYING, State.Deployment.PENDING])
            //.where('checkedAt', '<', new Date().getTime() - 10000) // max one check every 10sec. - TODO create a parameter
            .get()
            .then(querySnapshot => {
                const arr = [];
                if (!querySnapshot.empty) {
                    querySnapshot.forEach(doc => {
                        arr.push([doc.data(), doc.ref]);
                    });
                }
                return arr;
            });
    }

    /**
     * Update the state of all DEPLOYING deployments according the state of the workflow execution.
     * @returns 
     */
    updateRunningDeployments = appId => {
        return this.getRunningDeployments(appId).then(deployments => {
            return Promise.all(deployments.map(([deployment, ref]) => {
                return executionsClient.getExecution({
                    name: deployment.execution,
                }).then(([execution]) => {
                    return [deployment, execution, ref];
                });
            }));
        }).then(deployments => {
            const timestamp = new Date().getTime();
            return Promise.all(deployments.map(([deployment, execution, ref]) => {
                // only update deploying deployment
                if (deployment.state != State.Deployment.DEPLOYING
                    && deployment.state != State.Deployment.PENDING) return;

                if (execution.state == State.Execution.SUCCEEDED) {
                    return ref.update({
                        state: State.Deployment.DEPLOYED,
                        checkedAt: timestamp,
                        completedAt: execution.endTime,
                        //output: JSON.parse(execution.result)
                    });
                } else if (execution.state == State.Execution.CANCELLED) {
                    return ref.update({
                        state: State.Deployment.CANCELLED,
                        checkedAt: timestamp,
                        completedAt: execution.endTime,
                    });
                } else if (execution.state == State.Execution.FAILED
                    || execution.state == State.Execution.STATE_UNSPECIFIED) {
                    return ref.update({
                        state: State.Deployment.FAILED,
                        checkedAt: timestamp,
                        completedAt: execution.endTime,
                    });
                }
            }));
        });
    }

    /**
     * need index: : ASC packageType: ASC state: ASC createdAt: ASC __name__: ASC
     * @param {*} appId
     * @param {*} deploymentId 
     * @param {*} deploymentsRef 
     * @returns 
     */
    isFirstDeploymentQueued = (appId, deploymentId) => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        return appRef.collection('deployments')
            .where('state', 'in', [State.Deployment.PENDING, State.Deployment.DEPLOYING])
            .orderBy('createdAt', 'asc')
            .limit(1)
            .get()
            .then(qs => !qs.empty && deploymentId === qs.docs[0].id); // the document id is the deploymentId

    }

    /**
     * need index: : ASC packageType: ASC state: ASC createdAt: DESC __name__: DESC
     * @param {*} appId
     * @param {*} deploymentId 
     * @param {*} deploymentsRef 
     * @returns 
     */
    isLastDeploymentQueued = (appId, deploymentId) => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        return appRef.collection('deployments')
            .where('state', '==', State.Deployment.PENDING)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get()
            .then(qs => !qs.empty && deploymentId === qs.docs[0].id); // the document id is the deploymentId
    }

    /**
     * Update packages according the deploying deployent state
     * @param {*} packageType 
     * @returns 
     */
    /*updateDeployingApps = () => {
        return this.appRef
            .where('state', '==', State.App.DEPLOYING)
            .get()
            .then(snapshot => {
                if (snapshot.empty) return;
                var arr = [];
                snapshot.forEach(doc => arr.push(this.updateDeployingApp(doc.id)));
                return Promise.all(arr);
            });
    }*/

    /**
     * Update an package according the deploying deployment state
     * @param {*} appId
     * @returns 
     */
    updateDeployingApp = appId => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        return db.runTransaction(transaction => {
            return transaction.get(appRef).then(doc => {
                if (!doc.exists) return;
                const pkg = doc.data();
                const deployingId = pkg.deploying?.deploymentId;
                if (!deployingId) return;
                // get the deployment
                return appRef.collection('deployments').doc(deployingId).get().then(doc => {
                    if (!doc.exists) return; // TODO
                    const deployment = doc.data();
                    if (deployment.state == State.Deployment.DEPLOYING) {
                        // do nothing
                    } else if (deployment.state == State.Deployment.DEPLOYED) {
                        transaction.update(appRef, {
                            state: State.App.DEPLOYED,
                            deploying: FieldValue.delete(),
                            architectureFile: deployment.architectureFile,
                        });
                    } else if (deployment.state == State.Deployment.FAILED) {
                        transaction.update(appRef, {
                            state: State.App.FAILED,
                            deploying: {
                                architectureFile: deployment.architectureFile,
                                deploymentId: deployment.deploymentId
                            }
                        });
                    } else if (deployment.state == State.Deployment.CANCELLED) {
                        transaction.update(appRef, {
                            state: State.App.CANCELLED,
                            deploying: {
                                architectureFile: deployment.architectureFile,
                                deploymentId: deployment.deploymentId
                            }
                        });
                    } else if (deployment.state == State.Deployment.SKIPPED) {
                        // should never occur
                        transaction.update(appRef, {
                            state: State.App.CANCELLED,
                            deploying: {
                                architectureFile: deployment.architectureFile,
                                deploymentId: deployment.deploymentId
                            }
                        });
                    }
                });
            });
        });
    }

    /**
     * Check if the PENDING deployment can go to the DEPLOYING state.
     * Check if the PENDING deployment can be SKIPPED.
     * 
     * If the deployment is not in a PENDING state, nothing is checked.
     * 
     * Called by the workflow itself
     * 
     * @param {*} deploymentId 
     * @returns 
     */
    checkPendingDeployment = (appId, deploymentId) => {
        const appDatabaseId = encodeURIComponent(appId);
        const appRef = db.collection('apps').doc(appDatabaseId);
        const deploymentRef = appRef.collection('deployments').doc(deploymentId);
        return db.runTransaction(transaction => {
            return transaction.get(deploymentRef).then(doc => {
                if (!doc.exists) return;
                var deployment = doc.data();
                if (deployment.state != State.Deployment.PENDING) return;
                // get the position in the "queue" based on the createdAt field.
                return Promise.all([
                    this.isFirstDeploymentQueued(appId, deploymentId),
                    this.isLastDeploymentQueued(appId, deploymentId),
                ]).then(([isFirst, isLast]) => {
                    const timestamp = new Date().getTime();
                    if (!isLast) {
                        // It is not a problem if the isLast is not consistant anymore during this request
                        // as we do nothing if the deployment is the last one.
                        // Cancel the execution
                        transaction.update(deploymentRef, {
                            state: State.Deployment.SKIPPED,
                            completedAt: timestamp,
                            checkedAt: timestamp,
                        });
                    }
                    if (isFirst) {
                        // Here we authorize the deployment to start deploying
                        deployment.state = State.Deployment.DEPLOYING;
                        deployment.checkedAt = timestamp;
                        deployment.deployingAt = timestamp;
                        transaction.update(deploymentRef, {
                            state: deployment.state,
                            checkedAt: deployment.checkedAt,
                            deployingAt: deployment.deployingAt,
                        });
                        transaction.update(appRef, {
                            state: State.App.DEPLOYING,
                            deploying: {
                                architectureFile: deployment.architectureFile,
                                deploymentId: deployment.deploymentId
                            }
                        });
                    }
                });
            });
        });
    }

}

export default DeploymentQueue;













/*

    getDeployments = (states, size = 100, opt_startAfter) => {
        if (size < 0) throw Errors.INVALID('Size must be > or equals to 0.');
        size = Math.min(size, 100); // TODO throw error ?
        var ref = this.root.doc(packageId).collection(DEPLOYMENT_COLLECTION);
        if (states.length > 0) {
            ref = ref.where('state', 'in', states);
        }
        ref = ref.orderBy('createdAt', 'desc');
        if (opt_startAfter) {
            ref = ref.startAfter(opt_startAfter)
        }
        return ref.limit(size)
            .get()
            .then(querySnapshot => {
                var arr = [];
                if (!querySnapshot.empty) {
                    querySnapshot.forEach(doc => {
                        arr.push(doc.data());
                    });
                }
                return arr;
            });
    }

*/