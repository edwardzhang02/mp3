var User = require('../models/user');
var Task = require('../models/task');
var api = require('../utils/api');
var ApiError = api.ApiError;

var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
var UNASSIGNED = { assignedUser: '', assignedUserName: 'unassigned' };

// Check the body of POST/PUT /users (400 on bad input).
// Returns { name, email, pendingTasks } with pendingTasks de-duplicated.
function parseUserBody(req) {
    var body = api.readBody(req);

    if (!api.isNonEmptyString(body.name)) {
        throw new ApiError(400, 'A user must have a name');
    }
    if (!api.isNonEmptyString(body.email)) {
        throw new ApiError(400, 'A user must have an email');
    }
    if (!EMAIL_PATTERN.test(body.email)) {
        throw new ApiError(400, 'The email address is not valid');
    }

    var pendingTasks = body.pendingTasks;
    if (pendingTasks === undefined || pendingTasks === null) pendingTasks = [];
    // A form body with a single value gives a string instead of a list
    if (typeof pendingTasks === 'string' && api.isFormBody(req)) {
        pendingTasks = pendingTasks === '' ? [] : [pendingTasks];
    }
    if (!Array.isArray(pendingTasks)) {
        throw new ApiError(400, 'pendingTasks must be a list of task ids');
    }
    pendingTasks.forEach(function (taskId) {
        if (!api.isValidId(taskId)) {
            throw new ApiError(400, 'pendingTasks contains an invalid task id: ' + JSON.stringify(taskId));
        }
    });

    return {
        name: body.name,
        email: body.email,
        pendingTasks: Array.from(new Set(pendingTasks))
    };
}

// Check that the email is free and that the tasks in pendingTasks exist
// (404) and are not completed (400). userId is null for a new user.
async function checkUserReferences(fields, userId) {
    var emailFilter = { email: fields.email };
    if (userId) emailFilter._id = { $ne: userId };
    if (await User.exists(emailFilter)) {
        throw new ApiError(400, 'A user with this email already exists');
    }

    if (fields.pendingTasks.length === 0) return;
    var tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).select('completed');
    if (tasks.length !== fields.pendingTasks.length) {
        var found = tasks.map(function (task) { return String(task._id); });
        var missing = fields.pendingTasks.filter(function (id) { return found.indexOf(id) === -1; });
        throw new ApiError(404, 'Task not found: ' + missing.join(', '));
    }
    var completed = tasks.filter(function (task) { return task.completed; });
    if (completed.length > 0) {
        throw new ApiError(400, 'Completed tasks cannot be pending: ' +
            completed.map(function (task) { return String(task._id); }).join(', '));
    }
}

// Save the user, translating a duplicate email (race with another request) into a 400
async function saveUser(user) {
    try {
        return await user.save();
    } catch (err) {
        if (err.code === 11000) throw new ApiError(400, 'A user with this email already exists');
        throw err;
    }
}

// After a user was saved with a new pendingTasks list, update the tasks so
// both sides agree. oldPending is the user's previous pendingTasks.
async function syncUserTasks(user, oldPending) {
    var userId = String(user._id);
    var pending = user.pendingTasks;
    var removed = oldPending.filter(function (id) {
        return pending.indexOf(id) === -1 && api.isValidId(id);
    });

    // Tasks no longer pending for this user become unassigned
    await Task.updateMany({
        assignedUser: userId,
        $or: [
            { _id: { $in: removed } },
            { completed: false, _id: { $nin: pending } }
        ]
    }, UNASSIGNED);

    if (pending.length > 0) {
        // Tasks taken over from other users leave their pendingTasks
        await User.updateMany(
            { _id: { $ne: userId }, pendingTasks: { $in: pending } },
            { $pull: { pendingTasks: { $in: pending } } }
        );
        await Task.updateMany({ _id: { $in: pending } }, { assignedUser: userId });
    }

    // Keep assignedUserName in sync on all of the user's tasks (completed too)
    await Task.updateMany({ assignedUser: userId }, { assignedUserName: user.name });
}

module.exports = function (router) {

    var usersRoute = router.route('/users');

    usersRoute.get(api.handle(async function (req, res) {
        var users = await api.listDocuments(User, req.query, undefined);
        api.send(res, 200, 'OK', users);
    }));

    usersRoute.post(api.handle(async function (req, res) {
        var fields = parseUserBody(req);
        await checkUserReferences(fields, null);

        var user = await saveUser(new User(fields));
        await syncUserTasks(user, []);
        api.send(res, 201, 'User created', user);
    }));

    var userRoute = router.route('/users/:id');

    userRoute.get(api.handle(async function (req, res) {
        var user = await api.findOneById(User, req.params.id, req.query);
        if (!user) throw new ApiError(404, 'User not found');
        api.send(res, 200, 'OK', user);
    }));

    userRoute.put(api.handle(async function (req, res) {
        var user = api.isValidId(req.params.id) ? await User.findById(req.params.id) : null;
        if (!user) throw new ApiError(404, 'User not found');

        var fields = parseUserBody(req);
        await checkUserReferences(fields, user._id);

        var oldPending = user.pendingTasks.slice();
        user.set(fields);
        await saveUser(user);
        await syncUserTasks(user, oldPending);
        api.send(res, 200, 'User updated', user);
    }));

    userRoute.delete(api.handle(async function (req, res) {
        var user = api.isValidId(req.params.id) ? await User.findById(req.params.id) : null;
        if (!user) throw new ApiError(404, 'User not found');

        await Task.updateMany({ assignedUser: String(user._id) }, UNASSIGNED);
        await User.deleteOne({ _id: user._id });
        res.status(204).end();
    }));

    return router;
};
