// Shared helpers for the API routes: response format, errors, id checks
// and the where/sort/select/skip/limit/count query string parameters.

// An error carrying the HTTP status and human readable message to send back
class ApiError extends Error {
    constructor(status, message, data) {
        super(message);
        this.status = status;
        this.data = data === undefined ? null : data;
    }
}

// Every response is { message, data }
function send(res, status, message, data) {
    res.status(status).json({ message: message, data: data === undefined ? null : data });
}

// A MongoDB ObjectId as a 24 character hex string. Stricter than
// mongoose.isValidObjectId, which also accepts any 12 character string.
function isValidId(id) {
    return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

// Read one query string parameter and JSON.parse it.
// Returns undefined if the parameter is not present.
function parseParam(query, name) {
    var raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
        throw new ApiError(400, 'Query parameter "' + name + '" must be given only once');
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, 'Query parameter "' + name + '" is not valid JSON');
    }
}

function parseObjectParam(query, name) {
    var value = parseParam(query, name);
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ApiError(400, 'Query parameter "' + name + '" must be a JSON object');
    }
    return value;
}

function parseIntParam(query, name) {
    var value = parseParam(query, name);
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 0) {
        throw new ApiError(400, 'Query parameter "' + name + '" must be a non-negative integer');
    }
    return value;
}

function parseBoolParam(query, name) {
    var value = parseParam(query, name);
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new ApiError(400, 'Query parameter "' + name + '" must be true or false');
    }
    return value;
}

// Errors raised by MongoDB/Mongoose because of what the client asked for
// (e.g. where={"_id": "abc"}, or a select mixing 1 and 0) are 400s.
// Anything else is a server problem.
var BAD_QUERY_CODES = [2, 31253, 31254];
function isClientQueryError(err) {
    if (!err) return false;
    if (err.name === 'CastError' || err.name === 'StrictModeError' || err.name === 'ValidationError') return true;
    if (err.name === 'MongoServerError' && BAD_QUERY_CODES.indexOf(err.code) !== -1) return true;
    return false;
}

// Run a query and turn client mistakes into 400s instead of 500s
async function runQuery(buildQuery) {
    var query;
    try {
        query = buildQuery();
    } catch (err) {
        throw new ApiError(400, 'Invalid query parameters');
    }
    try {
        return await query.exec();
    } catch (err) {
        if (isClientQueryError(err)) throw new ApiError(400, 'Invalid query parameters');
        throw err;
    }
}

// GET on a collection endpoint (GET /users, GET /tasks).
// defaultLimit is used when no limit is given (undefined = unlimited).
// count=true returns the number of matching documents; the default limit
// does not apply to it, but an explicit skip/limit does.
async function listDocuments(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseObjectParam(query, 'select');
    var skip = parseIntParam(query, 'skip');
    var limit = parseIntParam(query, 'limit');
    var count = parseBoolParam(query, 'count');

    if (count) {
        return runQuery(function () {
            var options = {};
            if (skip !== undefined) options.skip = skip;
            if (limit !== undefined) options.limit = limit;
            return Model.countDocuments(where, options);
        });
    }

    if (limit === undefined) limit = defaultLimit;
    return runQuery(function () {
        var q = Model.find(where);
        if (sort) q = q.sort(sort);
        if (select) q = q.select(select);
        if (skip !== undefined) q = q.skip(skip);
        if (limit !== undefined) q = q.limit(limit);
        return q;
    });
}

// GET on a single resource (GET /users/:id, GET /tasks/:id).
// Only `select` applies; other query parameters are ignored.
// Returns null if the id is malformed or no document has it.
async function findOneById(Model, id, query) {
    var select = parseObjectParam(query, 'select');
    if (!isValidId(id)) return null;
    return runQuery(function () {
        var q = Model.findById(id);
        if (select) q = q.select(select);
        return q;
    });
}

// The request body of a POST/PUT as an object ({} when there is none)
function readBody(req) {
    var body = req.body;
    if (body === undefined || body === null) return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'Request body must be a JSON object');
    }
    return body;
}

// Form encoded bodies (x-www-form-urlencoded) carry every value as a string
function isFormBody(req) {
    return Boolean(req.is('application/x-www-form-urlencoded'));
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

// true/false, also accepting "true"/"false" (form bodies)
function parseBoolean(value) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
}

// Wrap an async route handler so thrown errors reach the error handler
function handle(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// Express error handler (registered after all routes)
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) {
        return send(res, err.status, err.message, err.data);
    }
    // Malformed JSON request body (from express.json)
    if (err.type === 'entity.parse.failed') {
        return send(res, 400, 'Request body is not valid JSON');
    }
    console.error(err);
    send(res, 500, 'Internal server error, please try again later');
}

// Catch-all for unknown routes
function notFoundHandler(req, res) {
    send(res, 404, 'Endpoint not found');
}

module.exports = {
    ApiError: ApiError,
    send: send,
    isValidId: isValidId,
    listDocuments: listDocuments,
    findOneById: findOneById,
    readBody: readBody,
    isFormBody: isFormBody,
    isNonEmptyString: isNonEmptyString,
    parseBoolean: parseBoolean,
    handle: handle,
    errorHandler: errorHandler,
    notFoundHandler: notFoundHandler
};
