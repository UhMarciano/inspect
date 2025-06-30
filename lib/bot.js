const winston = require('winston'),
    SteamUser = require('steam-user'),
    GlobalOffensive = require('globaloffensive'),
    SteamTotp = require('steam-totp'),
    EventEmitter = require('events').EventEmitter;
const {error} = require("winston");

class Bot extends EventEmitter {
    /**
     * Sets the ready status and sends a 'ready' or 'unready' event if it has changed
     * @param {*|boolean} val New ready status
     */
    set ready(val) {
        const prev = this.ready;
        this.ready_ = val;

        if (val !== prev) {
            // Use setImmediate to prevent blocking the event loop
            setImmediate(() => {
                this.emit(val ? 'ready' : 'unready');
            });
        }
    }

    /**
     * Returns the current ready status
     * @return {*|boolean} Ready status
     */
    get ready() {
        return this.ready_ || false;
    }

    constructor(settings) {
        super();

        this.settings = Object.assign({
            request_delay: 1000,
            request_ttl: 30000,
            max_retries: 3,
            retry_delay: 5000,
            connection_timeout: 15000,
            max_concurrent_requests: 5,
            gc_reconnect_delay: 10000,
            login_retry_delay: 60000
        }, settings);

        this.busy = false;
        this.requestQueue = [];
        this.activeRequests = 0;
        this.retryCount = 0;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 5;

        // Graceful shutdown handling
        this.isShuttingDown = false;
        this.setupGracefulShutdown();

        this.steamClient = new SteamUser(Object.assign({
            promptSteamGuardCode: false,
            enablePicsCache: true,
            httpRequestTimeout: this.settings.connection_timeout,
            protocol: SteamUser.EConnectionProtocol.WebSocket // More reliable than TCP
        }, this.settings.steam_user));

        this.csgoClient = new GlobalOffensive(this.steamClient);

        // Set up event handlers with error boundaries
        this.bindEventHandlers();

        // Staggered relogin with exponential backoff
        this.setupPeriodicRelogin();

        this.isLoggedIn = false;
        this.isLoggingIn = false;
        this.loginPoller = null;
        this.startLoginPoller();

        // Simple rate limiting instead of event loop monitoring
        this.lastRequestTime = 0;
    }

    setupGracefulShutdown() {
        const cleanup = () => {
            winston.info(`${this.username} Shutting down gracefully...`);
            this.destroy();
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('uncaughtException', (err) => {
            winston.error(`${this.username} Uncaught exception:`, err);
            cleanup();
        });
        process.on('unhandledRejection', (reason, promise) => {
            winston.error(`${this.username} Unhandled rejection at:`, promise, 'reason:', reason);
        });
    }

    // Simple rate limiting check
    canProcessRequest() {
        const now = Date.now();
        if (now - this.lastRequestTime < this.settings.request_delay) {
            return false;
        }
        return true;
    }

    setupPeriodicRelogin() {
        // Variance to prevent all bots from relogging at the same time
        const variance = parseInt(Math.random() * 4 * 60 * 1000);
        const baseInterval = 30 * 60 * 1000; // 30 minutes

        this.reloginTimer = setInterval(() => {
            if (this.isShuttingDown) return;

            // Only relog if we have an active GC session and no pending requests
            if (this.csgoClient.haveGCSession && this.activeRequests === 0) {
                winston.info(`${this.username} Scheduled relogin`);
                this.relogin = true;
                this.gracefulReconnect();
            }
        }, baseInterval + variance);
    }

    gracefulReconnect() {
        // Wait for active requests to complete before reconnecting
        if (this.activeRequests > 0) {
            winston.info(`${this.username} Waiting for ${this.activeRequests} active requests before reconnecting`);
            setTimeout(() => this.gracefulReconnect(), 1000);
            return;
        }

        this.steamClient.relog();
    }

    startLoginPoller() {
        if (this.loginPoller) clearInterval(this.loginPoller);

        this.loginPoller = setInterval(() => {
            if (this.isShuttingDown) return;

            if (!this.isLoggedIn && !this.isLoggingIn) {
                winston.warn(`${this.username} not logged in, attempting login (attempt ${this.connectionAttempts + 1})`);
                this.attemptLogin();
            }
        }, this.settings.login_retry_delay);
    }

    async attemptLogin() {
        if (this.connectionAttempts >= this.maxConnectionAttempts) {
            winston.error(`${this.username} Max connection attempts reached, backing off`);

            // Exponential backoff
            const backoffTime = Math.min(300000, 5000 * Math.pow(2, this.connectionAttempts - this.maxConnectionAttempts));
            setTimeout(() => {
                this.connectionAttempts = 0;
                this.attemptLogin();
            }, backoffTime);
            return;
        }

        this.connectionAttempts++;
        this.isLoggingIn = true;

        try {
            await this.logIn(this.username, this.password, this.auth);
        } catch (error) {
            winston.error(`${this.username} Login failed:`, error);
            this.isLoggingIn = false;
        }
    }

    async logIn(username, password, auth) {
        return new Promise((resolve, reject) => {
            this.ready = false;
            this.isLoggedIn = false;
            this.isLoggingIn = true;

            // Save these parameters if we login later
            if (arguments.length === 3) {
                this.username = username;
                this.password = password;
                this.auth = auth;
            }

            winston.info(`Logging in ${this.username}`);

            // If there is a steam client, make sure it is disconnected
            if (this.steamClient) {
                this.steamClient.logOff();
            }

            this.loginData = {
                accountName: this.username,
                password: this.password,
                rememberPassword: true,
            };

            if (this.auth && this.auth !== '') {
                // Check if it is a shared_secret
                if (this.auth.length <= 5) {
                    this.loginData.authCode = this.auth;
                } else {
                    // Generate the code from the shared_secret
                    winston.debug(`${this.username} Generating TOTP Code from shared_secret`);
                    try {
                        this.loginData.twoFactorCode = SteamTotp.getAuthCode(this.auth);
                    } catch (error) {
                        winston.error(`${this.username} Failed to generate TOTP code:`, error);
                        this.isLoggingIn = false;
                        return reject(error);
                    }
                }
            }

            // Set login timeout
            const loginTimeout = setTimeout(() => {
                winston.error(`${this.username} Login timeout`);
                this.isLoggingIn = false;
                reject(new Error('Login timeout'));
            }, this.settings.connection_timeout);

            // Set up one-time login success handler
            const onLoginSuccess = () => {
                clearTimeout(loginTimeout);
                this.connectionAttempts = 0;
                resolve();
            };

            // Set up one-time login error handler
            const onLoginError = (error) => {
                clearTimeout(loginTimeout);
                this.steamClient.removeListener('loggedOn', onLoginSuccess);
                reject(error);
            };

            this.steamClient.once('loggedOn', onLoginSuccess);
            this.steamClient.once('error', onLoginError);

            winston.debug(`${this.username} About to connect`);

            // Use setImmediate to prevent blocking
            setImmediate(() => {
                this.steamClient.logOn(this.loginData);
            });
        });
    }

    bindEventHandlers() {
        // Wrap all event handlers with try-catch to prevent crashes
        const safeHandler = (handler, handlerName = 'unknown') => {
            return (...args) => {
                try {
                    handler.apply(this, args);
                } catch (error) {
                    winston.error(`${this.username} Error in event handler (${handlerName}):`, error);

                    // If error occurs in inspectItemInfo handler, clean up the request
                    if (handlerName === 'inspectItemInfo') {
                        this.handleRequestError(error);
                    }
                }
            };
        };

        this.steamClient.on('error', safeHandler((err) => {
            winston.error(`Error logging in ${this.username}:`, err);
            this.isLoggingIn = false;
            this.isLoggedIn = false;

            const loginErrorMsgs = {
                61: 'Invalid Password',
                63: 'Account login denied due to 2nd factor authentication failure. If using email auth, an email has been sent.',
                65: 'Account login denied due to auth code being invalid',
                66: 'Account login denied due to 2nd factor auth failure and no mail has been sent',
                84: 'Rate limit exceeded'
            };

            if (err.eresult && loginErrorMsgs[err.eresult] !== undefined) {
                winston.error(`${this.username}: ${loginErrorMsgs[err.eresult]}`);

                // Handle rate limiting
                if (err.eresult === 84) {
                    this.connectionAttempts = this.maxConnectionAttempts;
                }
            }

            // Handle proxy timeout
            if (err.toString().includes('Proxy connection timed out')) {
                setTimeout(() => {
                    if (!this.isShuttingDown) {
                        this.attemptLogin();
                    }
                }, this.settings.retry_delay);
            }
        }));

        this.steamClient.on('disconnected', safeHandler((eresult, msg) => {
            winston.warn(`${this.username} Logged off (${eresult}, ${msg})`);
            this.isLoggedIn = false;
            this.ready = false;

            // Don't immediately reconnect, let the login poller handle it
            if (!this.isShuttingDown && !this.relogin) {
                setTimeout(() => {
                    if (!this.isLoggedIn && !this.isLoggingIn) {
                        this.attemptLogin();
                    }
                }, this.settings.gc_reconnect_delay);
            }
        }));

        this.steamClient.on('loggedOn', safeHandler((details, parental) => {
            this.isLoggedIn = true;
            this.isLoggingIn = false;
            this.connectionAttempts = 0;
            winston.info(`${this.username} Log on OK`);

            // Use setImmediate to prevent blocking
            setImmediate(() => {
                // Fixes reconnecting to CS:GO GC
                this.steamClient.gamesPlayed([], true);

                if (this.relogin) {
                    winston.info(`${this.username} Initiating GC Connection, Relogin`);
                    this.steamClient.gamesPlayed([730], true);
                    this.relogin = false;
                    return;
                }

                // Ensure we own CSGO
                this.steamClient.once('ownershipCached', () => {
                    this.handleOwnershipCheck();
                });
            });
        }));

        this.csgoClient.on('inspectItemInfo', safeHandler((itemData) => {
            this.handleInspectResponse(itemData);
        }, 'inspectItemInfo'));

        this.csgoClient.on('connectedToGC', safeHandler(() => {
            winston.info(`${this.username} CSGO Client Ready!`);
            this.ready = true;
            this.processRequestQueue();
        }));

        this.csgoClient.on('disconnectedFromGC', safeHandler((reason) => {
            this.isLoggedIn = false;
            this.isLoggingIn = false;
            winston.warn(`${this.username} CSGO unready (${reason})`);
            this.ready = false;
        }));

        this.csgoClient.on('connectionStatus', safeHandler((status) => {
            winston.debug(`${this.username} GC Connection Status Update ${status}`);
        }));

        this.csgoClient.on('debug', safeHandler((msg) => {
            winston.debug(msg);
        }));
    }

    handleOwnershipCheck() {
        if (!this.steamClient.ownsApp(730)) {
            winston.info(`${this.username} doesn't own CS:GO, retrieving free license`);

            this.steamClient.requestFreeLicense([730], (err, grantedPackages, grantedAppIDs) => {
                if (err) {
                    winston.error(`${this.username} Failed to obtain free CS:GO license:`, err);
                    return;
                }

                winston.debug(`${this.username} Granted Packages`, grantedPackages);
                winston.debug(`${this.username} Granted App IDs`, grantedAppIDs);
                winston.info(`${this.username} Initiating GC Connection`);

                setImmediate(() => {
                    this.steamClient.gamesPlayed([730], true);
                });
            });
        } else {
            winston.info(`${this.username} Initiating GC Connection`);
            setImmediate(() => {
                this.steamClient.gamesPlayed([730], true);
            });
        }
    }

    handleInspectResponse(itemData) {
        if (!this.resolve || !this.currentRequest) return;

        try {
            itemData = { iteminfo: itemData };

            // Ensure the received itemid is the same as what we want
            if (itemData.iteminfo.itemid !== this.currentRequest.a) return;

            // Clear any TTL timeout
            if (this.ttlTimeout) {
                clearTimeout(this.ttlTimeout);
                this.ttlTimeout = null;
            }

            // Calculate delay
            const offset = new Date().getTime() - this.currentRequest.time;
            let delay = this.settings.request_delay - offset;
            if (delay < 0) delay = 0;

            // Process item data
            this.processItemData(itemData, delay);

            // Resolve the promise
            this.resolve(itemData);
            this.resolve = null;
            this.currentRequest = null;
            this.activeRequests--;

            // Schedule next request processing with proper delay
            setTimeout(() => {
                this.busy = false;
                // Use setTimeout instead of setImmediate to prevent rapid cycling
                setTimeout(() => this.processRequestQueue(), 10);
            }, delay);

        } catch (error) {
            winston.error(`${this.username} Error processing inspect response:`, error);
            this.handleRequestError(error);
        }
    }

    processItemData(itemData, delay) {
        itemData.delay = delay;
        itemData.iteminfo.s = this.currentRequest.s;
        itemData.iteminfo.a = this.currentRequest.a;
        itemData.iteminfo.d = this.currentRequest.d;
        itemData.iteminfo.m = this.currentRequest.m;

        // If the paintseed is 0, the proto returns null, force 0
        itemData.iteminfo.paintseed = itemData.iteminfo.paintseed || 0;

        // paintwear -> floatvalue for backward compatibility
        itemData.iteminfo.floatvalue = itemData.iteminfo.paintwear;
        delete itemData.iteminfo.paintwear;

        // Backward compatibility with previous node-globaloffensive versions
        if (itemData.iteminfo.stickers) {
            for (const sticker of itemData.iteminfo.stickers) {
                sticker.stickerId = sticker.sticker_id;
                delete sticker.sticker_id;
            }
        }
    }

    processRequestQueue() {
        if (this.isShuttingDown || this.busy || !this.ready || this.requestQueue.length === 0) {
            return;
        }

        if (this.activeRequests >= this.settings.max_concurrent_requests) {
            return;
        }

        // Simple rate limiting check
        if (!this.canProcessRequest()) {
            setTimeout(() => this.processRequestQueue(), this.settings.request_delay);
            return;
        }

        const request = this.requestQueue.shift();
        if (request) {
            this.lastRequestTime = Date.now();
            this.executeRequest(request);
        }
    }

    executeRequest(request) {
        this.activeRequests++;
        this.busy = true;
        this.resolve = request.resolve;
        this.currentRequest = {
            ...request.params,
            reject: request.reject  // Store reject function for error handling
        };

        try {
            const params = request.params;
            winston.debug(`${this.username} Fetching for ${params.a}`);

            // The first param (owner) depends on the type of inspect link
            this.csgoClient.inspectItem(
                params.s !== '0' ? params.s : params.m,
                params.a,
                params.d
            );

            // Set timeout for the request
            this.ttlTimeout = setTimeout(() => {
                this.handleRequestTimeout();
            }, this.settings.request_ttl);

        } catch (error) {
            winston.error(`${this.username} Error executing request:`, error);
            this.handleRequestError(error);
        }
    }

    handleRequestTimeout() {
        winston.warn(`${this.username} Request timeout for item ${this.currentRequest?.a}`);
        this.handleRequestError(new Error('Request timeout'));
    }

    handleRequestError(error) {
        winston.error(`${this.username} Request error:`, error);

        if (this.ttlTimeout) {
            clearTimeout(this.ttlTimeout);
            this.ttlTimeout = null;
        }

        this.busy = false;
        this.activeRequests = Math.max(0, this.activeRequests - 1);

        // Reject the current request if it exists
        if (this.resolve && this.currentRequest) {
            const reject = this.currentRequest.reject;
            this.resolve = null;
            this.currentRequest = null;

            // Call reject if it exists (for queued requests)
            if (reject) {
                reject(error);
            }
        }

        // Process next request with delay to prevent tight loops
        setTimeout(() => this.processRequestQueue(), this.settings.request_delay / 4);
    }

    async sendFloatRequest(link) {
        return new Promise((resolve, reject) => {
            if (this.isShuttingDown) {
                reject(new Error('Bot is shutting down'));
                return;
            }

            if (!this.ready) {
                reject(new Error('Bot is not ready'));
                return;
            }

            try {
                const params = link.getParams();
                const requestData = {
                    s: params.s,
                    a: params.a,
                    d: params.d,
                    m: params.m,
                    time: new Date().getTime(),
                    resolve: resolve,
                    reject: reject
                };

                // Add to queue instead of executing immediately
                this.requestQueue.push({
                    params: requestData,
                    resolve: resolve,
                    reject: reject
                });

                // Process queue with small delay to prevent tight loops
                setTimeout(() => this.processRequestQueue(), 10);

            } catch (error) {
                reject(error);
            }
        });
    }

    // Cleanup method
    destroy() {
        this.isShuttingDown = true;

        if (this.loginPoller) {
            clearInterval(this.loginPoller);
            this.loginPoller = null;
        }

        if (this.reloginTimer) {
            clearInterval(this.reloginTimer);
            this.reloginTimer = null;
        }

        if (this.ttlTimeout) {
            clearTimeout(this.ttlTimeout);
            this.ttlTimeout = null;
        }

        if (this.ttlTimeout) {
            clearTimeout(this.ttlTimeout);
            this.ttlTimeout = null;
        }

        if (this.steamClient) {
            this.steamClient.logOff();
        }

        // Reject all pending requests
        this.requestQueue.forEach(req => {
            if (req.reject) {
                req.reject(new Error('Bot destroyed'));
            }
        });
        this.requestQueue = [];
    }
}

module.exports = Bot;