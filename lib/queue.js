const EventEmitter = require('events').EventEmitter;
const errors = require('../errors');

class Queue extends EventEmitter {
    constructor() {
        super();

        // Create separate queues for each priority level (1=high, 5=lowest)
        this.priorityQueues = {
            1: [], // High priority - process quick
            2: [], // Medium priority
            3: [], // Low priority
            4: [], // Very low priority
            5: [], // When there is time
        };
        this.users = {};
        this.running = false;
        this.activeJobsCount = 0;
        this.processingLock = false; // To prevent concurrent checkQueue calls
    }

    process(concurrency, controller, handler) {
        this.handler = handler;
        this.concurrency = concurrency;

        this.start();

        // Monkey patch to ensure queue processing size matches amount of bots ready
        setInterval(() => {
            const oldConcurrency = this.concurrency;
            this.concurrency = controller.getReadyAmount();

            if (this.concurrency > oldConcurrency) {
                for (let i = 0; i < this.concurrency - oldConcurrency; i++) {
                    this.checkQueue();
                }
            }
        }, 50);
    }

    size() {
        return Object.values(this.priorityQueues).reduce((total, queue) => total + queue.length, 0);
    }

    getProcessingCount() {
        return this.activeJobsCount;
    }

    addJob(job, max_attempts, priority = 3) {
        if (!(job.ip in this.users)) {
            this.users[job.ip] = 0;
        }

        for (const link of job.getRemainingLinks()) {
            this.priorityQueues[priority].push({
                data: link,
                max_attempts,
                attempts: 0,
                ip: job.ip,
                priority,
            });

            this.users[job.ip]++;
            this.checkQueue();
        }
    }

    async checkQueue() {
        // Prevent overlapping executions of checkQueue
        if (this.processingLock) return;
        this.processingLock = true;

        try {
            while (this.running && this.size() > 0 && this.activeJobsCount < this.concurrency) {
                let job = null;

                // Pick job from highest priority non-empty queue
                for (let priority = 1; priority <= 5; priority++) {
                    if (this.priorityQueues[priority].length > 0) {
                        job = this.priorityQueues[priority].shift();
                        break;
                    }
                }

                if (!job) break;

                this.activeJobsCount++;

                // Process job asynchronously but wait before starting next in this loop to keep concurrency correct
                this.handler(job).then((delay) => {
                    if (!delay) delay = 0;

                    this.users[job.ip]--;

                    // Cleanup user count if zero
                    if (this.users[job.ip] === 0) {
                        delete this.users[job.ip];
                    }

                    return new Promise(resolve => setTimeout(resolve, delay));
                }).catch((err) => {
                    if (err !== errors.NoBotsAvailable) {
                        job.attempts++;
                    }

                    if (job.attempts >= job.max_attempts) {
                        this.emit('job failed', job, err);
                        this.users[job.ip]--;

                        if (this.users[job.ip] === 0) {
                            delete this.users[job.ip];
                        }
                    } else {
                        // Retry after exponential backoff delay
                        const backoffDelay = 1000 * Math.pow(2, job.attempts - 1);

                        setTimeout(() => {
                            this.priorityQueues[job.priority].unshift(job);
                            this.checkQueue();
                        }, backoffDelay);
                    }
                }).finally(() => {
                    this.activeJobsCount--;
                    // Trigger next checkQueue if still running and jobs available
                    if (this.running && this.size() > 0) {
                        this.checkQueue();
                    }
                });
            }
        } finally {
            this.processingLock = false;
        }
    }

    getUserQueuedAmt(ip) {
        return this.users[ip] || 0;
    }

    start() {
        if (!this.running) {
            this.running = true;
            this.checkQueue();
        }
    }

    pause() {
        if (this.running) {
            this.running = false;
        }
    }
}

module.exports = Queue;
