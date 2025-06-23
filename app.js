global._mckay_statistics_opt_out = true; // Opt out of node-steam-user stats

const optionDefinitions = [
    { name: 'config', alias: 'c', type: String, defaultValue: './config.js' }, // Config file location
    { name: 'steam_data', alias: 's', type: String } // Steam data directory
];

const args = require('command-line-args')(optionDefinitions);

const winston = require('winston');
const { combine, timestamp, printf, colorize } = winston.format;
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');

// Load config first
const CONFIG = require(args.config);

// Configure default Winston logger before importing other modules
winston.configure({
    level: CONFIG.logLevel || 'debug',
    format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// Now import other modules
const utils = require('./lib/utils');
const queue = new (require('./lib/queue'))();
const InspectURL = require('./lib/inspect_url');
const botController = new (require('./lib/bot_controller'))();
const memoryCache = new (require('./lib/memory_cache'))();
const gameData = new (require('./lib/game_data'))(CONFIG.game_files_update_interval, CONFIG.enable_game_file_updates);
const errors = require('./errors');
const Job = require('./lib/job');

// Setup Winston logger with Console transport
const logger = winston.createLogger({
    level: CONFIG.logLevel || 'debug',
    format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console()
    ],
});

if (CONFIG.max_simultaneous_requests === undefined) {
    CONFIG.max_simultaneous_requests = 1;
}

if (CONFIG.logins.length === 0) {
    console.log('There are no bot logins. Please add some in config.json');
    process.exit(1);
}

if (args.steam_data) {
    CONFIG.bot_settings.steam_user.dataDirectory = args.steam_data;
}

for (let [i, loginData] of CONFIG.logins.entries()) {
    const settings = Object.assign({}, CONFIG.bot_settings);
    if (CONFIG.proxies && CONFIG.proxies.length > 0) {
        const proxy = CONFIG.proxies[i % CONFIG.proxies.length];

        if (proxy.startsWith('http://')) {
            settings.steam_user = Object.assign({}, settings.steam_user, {httpProxy: proxy});
        } else if (proxy.startsWith('socks5://')) {
            settings.steam_user = Object.assign({}, settings.steam_user, {socksProxy: proxy});
        } else {
            console.log(`Invalid proxy '${proxy}' in config, must prefix with http:// or socks5://`);
            process.exit(1);
        }
    }

    botController.addBot(loginData, settings);
}

// Setup and configure express
const app = require('express')();
app.use(function (req, res, next) {
    if (req.method === 'POST') {
        // Default content-type
        req.headers['content-type'] = 'application/json';
    }
    next();
});
app.use(bodyParser.json({limit: '5mb'}));

app.use(function (error, req, res, next) {
    // Handle bodyParser errors
    if (error instanceof SyntaxError) {
        errors.BadBody.respond(res);
    }
    else next();
});

if (CONFIG.trust_proxy === true) {
    app.enable('trust proxy');
}

CONFIG.allowed_regex_origins = CONFIG.allowed_regex_origins || [];
CONFIG.allowed_origins = CONFIG.allowed_origins || [];
const allowedRegexOrigins = CONFIG.allowed_regex_origins.map((origin) => new RegExp(origin));

async function handleJob(job) {
    // See which items have already been cached
    const itemData = await memoryCache.getItemData(job.getRemainingLinks().map(e => e.link));
    for (let item of itemData) {
        const link = job.getLink(item.a);

        if (!item.price && link.price) {
            memoryCache.updateItemPrice(item.a, link.price);
        }

        gameData.addAdditionalItemProperties(item);
        item = utils.removeNullValues(item);

        job.setResponse(item.a, item);
    }

    if (!botController.hasBotOnline()) {
        return job.setResponseRemaining(errors.SteamOffline);
    }

    if (CONFIG.max_simultaneous_requests > 0 &&
        (queue.getUserQueuedAmt(job.ip) + job.remainingSize()) > CONFIG.max_simultaneous_requests) {
        return job.setResponseRemaining(errors.MaxRequests);
    }

    if (CONFIG.max_queue_size > 0 && (queue.size() + job.remainingSize()) > CONFIG.max_queue_size) {
        return job.setResponseRemaining(errors.MaxQueueSize);
    }

    if (job.remainingSize() > 0) {
        queue.addJob(job, CONFIG.bot_settings.max_attempts);
    }
}

function canSubmitPrice(key, link, price) {
    return CONFIG.price_key && key === CONFIG.price_key && price && link.isMarketLink() && utils.isOnlyDigits(price);
}

app.use(function (req, res, next) {
    if (CONFIG.allowed_origins.length > 0 && req.get('origin') != undefined) {
        // check to see if its a valid domain
        const allowed = CONFIG.allowed_origins.indexOf(req.get('origin')) > -1 ||
            allowedRegexOrigins.findIndex((reg) => reg.test(req.get('origin'))) > -1;

        if (allowed) {
            res.header('Access-Control-Allow-Origin', req.get('origin'));
            res.header('Access-Control-Allow-Methods', 'GET');
        }
    }
    next()
});

if (CONFIG.rate_limit && CONFIG.rate_limit.enable) {
    app.use(rateLimit({
        windowMs: CONFIG.rate_limit.window_ms,
        max: CONFIG.rate_limit.max,
        headers: false,
        handler: function (req, res) {
            errors.RateLimit.respond(res);
        }
    }))
}

app.post('/inspect', function(req, res) {
    // Validate API key
    if (!req.body.apiKey || req.body.apiKey !== CONFIG.api_key) {
        return res.status(403).json({
            error: 'Invalid API key',
            code: 8
        });
    }

    // Get and parse parameters
    let link;
    let priority = parseInt(req.body.priority) || 4;

    // Validate priority
    if (priority < 1 || priority > 5) {
        priority = 4;
    }

    if ('url' in req.body) {
        link = new InspectURL(req.body.url);
    }
    else if ('a' in req.body && 'd' in req.body && ('s' in req.body || 'm' in req.body)) {
        link = new InspectURL(req.body);
    }

    if (!link || !link.getParams()) {
        return errors.InvalidInspect.respond(res);
    }

    const job = new Job(req, res, /* bulk */ false);

    let price;
    if (canSubmitPrice(req.body.priceKey, link, req.body.price)) {
        price = parseInt(req.body.price);
    }

    job.add(link, price);

    try {
        // Pass priority to queue.addJob
        queue.addJob(job, CONFIG.bot_settings.max_attempts, priority);
    } catch (e) {
        logger.warn(e.toString());
        errors.GenericBad.respond(res);
    }
});

/*app.post('/bulk', (req, res) => {
    if (!req.body || (CONFIG.bulk_key && req.body.bulk_key != CONFIG.bulk_key)) {
        return errors.BadSecret.respond(res);
    }

    if (!req.body.links || req.body.links.length === 0) {
        return errors.BadBody.respond(res);
    }

    if (CONFIG.max_simultaneous_requests > 0 && req.body.links.length > CONFIG.max_simultaneous_requests) {
        return errors.MaxRequests.respond(res);
    }

    const job = new Job(req, res, /!* bulk *!/ true);

    for (const data of req.body.links) {
        const link = new InspectURL(data.link);
        if (!link.valid) {
            return errors.InvalidInspect.respond(res);
        }

        let price;

        if (canSubmitPrice(req.body.priceKey, link, data.price)) {
            price = parseInt(req.query.price);
        }

        job.add(link, price);
    }

    try {
        handleJob(job);
    } catch (e) {
        logger.warn(e.toString());
        errors.GenericBad.respond(res);
    }
});*/

app.get('/stats', (req, res) => {
    // Validate API key
    if (!req.body.apiKey || req.body.apiKey !== CONFIG.api_key) {
        return res.status(403).json({
            error: 'Invalid API key',
            code: 8
        });
    }

    res.json({
        bots_online: botController.getReadyAmount(),
        bots_total: botController.bots.length,
        queue_size: queue.size(),
        queue_concurrency: queue.concurrency,
        currently_processing_size: queue.getProcessingCount(),
    });
});

const http_server = require('http').Server(app);
http_server.listen(CONFIG.http.port);
logger.info('Listening for HTTP on port: ' + CONFIG.http.port);

queue.process(CONFIG.logins.length, botController, async (job) => {
    const itemData = await botController.lookupFloat(job.data.link);
    logger.debug(`Received itemData for ${job.data.link}`);

    // Save and remove the delay attribute
    let delay = itemData.delay;
    delete itemData.delay;

    await memoryCache.insertItemData(itemData.iteminfo, job.data.price);

    // Get rank, annotate with game files
    itemData.iteminfo = Object.assign(itemData.iteminfo, await memoryCache.getItemRank(itemData.iteminfo.a));
    gameData.addAdditionalItemProperties(itemData.iteminfo);

    itemData.iteminfo = utils.removeNullValues(itemData.iteminfo);
    itemData.iteminfo.stickers = itemData.iteminfo.stickers.map((s) => utils.removeNullValues(s));
    itemData.iteminfo.keychains = itemData.iteminfo.keychains.map((s) => utils.removeNullValues(s));

    job.data.job.setResponse(job.data.link.getParams().a, itemData.iteminfo);

    return delay;
});

queue.on('job failed', (job, err) => {
    const params = job.data.link.getParams();
    logger.warn(`Job Failed! S: ${params.s} A: ${params.a} D: ${params.d} M: ${params.m} IP: ${job.ip}, Err: ${(err || '').toString()}`);

    job.data.job.setResponse(params.a, errors.TTLExceeded);
});

module.exports.logger = logger;