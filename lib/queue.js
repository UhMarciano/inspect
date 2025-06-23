const EventEmitter = require('events').EventEmitter;
const errors = require('../errors');

class Queue extends EventEmitter {
    constructor() {
        super();

        // Create separate queues for each priority level
        this.priorityQueues = {
            1: [], // High priority - process quick
            2: [], // Medium priority
            3: [], // Low priority
            4: [], // Very low priority
            5: [], // When there is time
        };
        this.users = {};
        this.running = false;
    }

    process(concurrency, controller, handler) {
        this.handler = handler;
        this.concurrency = concurrency;
        this.processing = 0;

        this.start();

        // Monkey patch to ensure queue processing size is roughly equal to amount of bots ready
        setInterval(() => {
            // Update concurrency level, possible bots went offline or otherwise
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
        return this.processing;
    }

    addJob(job, max_attempts, priority = 3) {
        if (!(job.ip in this.users)) {
            this.users[job.ip] = 0;
        }

        for (const link of job.getRemainingLinks()) {
            this.priorityQueues[priority].push({
                data: link,
                max_attempts: max_attempts,
                attempts: 0,
                ip: job.ip,
                priority: priority
            });

            this.users[job.ip]++;
            this.checkQueue();
        }
    }

    checkQueue() {
        if (!this.running) return;

        if (this.size() > 0 && this.processing < this.concurrency) {
            // Get job from highest priority non-empty queue
            let job = null;
            for (let priority = 1; priority <= 3; priority++) {
                if (this.priorityQueues[priority].length > 0) {
                    job = this.priorityQueues[priority].shift();
                    break;
                }
            }

            if (job) {
                this.processing += 1;

                this.handler(job).then((delay) => {
                    if (!delay) delay = 0;
                    this.users[job.ip]--;

                    return new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                }).catch((err) => {
                    if (err !== errors.NoBotsAvailable) {
                        job.attempts++;
                    }

                    if (job.attempts === job.max_attempts) {
                        this.emit('job failed', job, err);
                        this.users[job.ip]--;
                    }
                    else {
                        // Try again with same priority
                        this.priorityQueues[job.priority].unshift(job);
                    }
                }).then(() => {
                    this.processing -= 1;
                    this.checkQueue();
                });
            }
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
        if (this.running) this.running = false;
    }
}

module.exports = Queue;