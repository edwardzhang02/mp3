/*
 * Connect all of your endpoints together here.
 */
var api = require('../utils/api');

module.exports = function (app, router) {
    require('./home.js')(router);
    require('./users.js')(router);
    require('./tasks.js')(router);
    app.use('/api', router);

    // Unknown routes and errors respond with { message, data } as well
    app.use(api.notFoundHandler);
    app.use(api.errorHandler);
};
