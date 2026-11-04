var User = require('../models/user');
var Task = require('../models/task');
var api = require('../utils/api');
var ApiError = api.ApiError;

var DEFAULT_TASK_LIMIT = 100;

// A deadline as a Date: an ISO date string or a timestamp in milliseconds
function parseDeadline(value) {
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
    if (typeof value !== 'number' && !api.isNonEmptyString(value)) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
}

// Check the body of POST/PUT /tasks (400 on bad input). Missing optional
// fields get their defaults, since PUT replaces the whole task.
function parseTaskBody(req) {
    var body = api.readBody(req);

    if (!api.isNonEmptyString(body.name)) {
        throw new ApiError(400, 'A task must have a name');
    }
    if (body.deadline === undefined || body.deadline === null || body.deadline === '') {
        throw new ApiError(400, 'A task must have a deadline');
    }
    var deadline = parseDeadline(body.deadline);
    if (!deadline) {
        throw new ApiError(400, 'The deadline is not a valid date');
    }

    var description = body.description;
    if (description === undefined || description === null) description = '';
    if (typeof description !== 'string') {
        throw new ApiError(400, 'description must be a string');
    }

    var completed = false;
    if (body.completed !== undefined && body.completed !== null) {
        completed = api.parseBoolean(body.completed);
        if (completed === undefined) throw new ApiError(400, 'completed must be true or false');
    }

    var assignedUser = body.assignedUser;
    if (assignedUser === undefined || assignedUser === null) assignedUser = '';
    if (typeof assignedUser !== 'string') {
        throw new ApiError(400, 'assignedUser must be a user id');
    }
    if (assignedUser !== '' && !api.isValidId(assignedUser)) {
        throw new ApiError(400, 'assignedUser is not a valid user id');
    }

    var assignedUserName = body.assignedUserName;
    if (assignedUserName === null || assignedUserName === '') assignedUserName = undefined;
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new ApiError(400, 'assignedUserName must be a string');
    }
    if (assignedUser === '') {
        if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
            throw new ApiError(400, 'assignedUserName is set but the task has no assignedUser');
        }
        assignedUserName = 'unassigned';
    }

    return {
        name: body.name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

// Check that the assigned user exists (404) and that assignedUserName is
// that user's name (400). Fills in assignedUserName when it was omitted.
async function checkTaskReferences(fields) {
    if (fields.assignedUser === '') return;
    var user = await User.findById(fields.assignedUser).select('name');
    if (!user) throw new ApiError(404, 'Assigned user not found');
    if (fields.assignedUserName === undefined) {
        fields.assignedUserName = user.name;
    } else if (fields.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName does not match the name of the assigned user');
    }
}

// After a task was saved, make it appear in exactly the pendingTasks of its
// assigned user if it is pending, and in nobody's pendingTasks otherwise.
async function syncTaskOwner(task) {
    var taskId = String(task._id);
    var owner = task.assignedUser !== '' && !task.completed ? task.assignedUser : null;

    var others = { pendingTasks: taskId };
    if (owner) others._id = { $ne: owner };
    await User.updateMany(others, { $pull: { pendingTasks: taskId } });

    if (owner) {
        await User.updateOne({ _id: owner }, { $addToSet: { pendingTasks: taskId } });
    }
}

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');

    tasksRoute.get(api.handle(async function (req, res) {
        var tasks = await api.listDocuments(Task, req.query, DEFAULT_TASK_LIMIT);
        api.send(res, 200, 'OK', tasks);
    }));

    tasksRoute.post(api.handle(async function (req, res) {
        var fields = parseTaskBody(req);
        await checkTaskReferences(fields);

        var task = await new Task(fields).save();
        await syncTaskOwner(task);
        api.send(res, 201, 'Task created', task);
    }));

    var taskRoute = router.route('/tasks/:id');

    taskRoute.get(api.handle(async function (req, res) {
        var task = await api.findOneById(Task, req.params.id, req.query);
        if (!task) throw new ApiError(404, 'Task not found');
        api.send(res, 200, 'OK', task);
    }));

    taskRoute.put(api.handle(async function (req, res) {
        var task = api.isValidId(req.params.id) ? await Task.findById(req.params.id) : null;
        if (!task) throw new ApiError(404, 'Task not found');

        var fields = parseTaskBody(req);
        await checkTaskReferences(fields);

        task.set(fields);
        await task.save();
        await syncTaskOwner(task);
        api.send(res, 200, 'Task updated', task);
    }));

    taskRoute.delete(api.handle(async function (req, res) {
        var task = api.isValidId(req.params.id) ? await Task.findById(req.params.id) : null;
        if (!task) throw new ApiError(404, 'Task not found');

        var taskId = String(task._id);
        await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
        await Task.deleteOne({ _id: task._id });
        res.status(204).end();
    }));

    return router;
};
