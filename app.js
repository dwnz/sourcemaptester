var raygun = require('raygun');
var raygunClient = new raygun.Client().init({
	apiKey: process.env.RAYGUN_KEY
});

var d = require('domain').create();
d.on('error', function(err) {
	raygunClient.send(error, {}, function() {
		console.log(err);
		process.exit(1);
	});
});

d.run(function() {
	var app = require('express')();
	var http = require('http').Server(app);
	var io = require('socket.io')(http);

    app.set('view engine', 'ejs');

	var SourceMapConsumer = require('source-map').SourceMapConsumer;
	var request = require('request');
	var nUrl = require('url');
	var validate = require('sourcemap-validator');

	function GetMapFileUrl(mapFiles, url) {
		var mapFile = mapFiles[0].substr('//# sourceMappingURL='.length);

		var host = nUrl.parse(url);

		var mapUrl = host.protocol + "//" + host.host;

		var urlPaths = host.path.split('/');
		for (var i = 0; i < urlPaths.length - 1; i++) {
			mapUrl += urlPaths[i] + '/';
		}

		mapUrl = nUrl.resolve(mapUrl, mapFile);

		return mapUrl;
	}

	function GetSourceFileUrl(sourceFile, url) {
		var host = nUrl.parse(url);

		var mapUrl = host.protocol + "//" + host.host;

		var urlPaths = host.path.split('/');
		for (var i = 0; i < urlPaths.length - 1; i++) {
			mapUrl += urlPaths[i] + '/';
		}

		mapUrl = nUrl.resolve(mapUrl, sourceFile);

		return mapUrl;
	}

	function GetScriptName(url) {
		var bits = url.split('/');
		return bits[bits.length - 1];
	}

	app.get('/', function(req, res) {
		res.render('index', {
			raygunKey: process.env.RAYGUN_KEY,
			query: req.query.query
		});
	});

	io.on('connection', function(socket) {
		socket.on('process', function(url) {
			if (!url) {
				socket.emit('log', 'ERROR: No url');
				socket.emit('done');
				return;
			}

			if (url.indexOf("http://") === -1 && url.indexOf('https://') === -1) {
				url = 'http://' + url;
			}

			var errors = [];

			var minifiedJS = null;
			var sourceMap = null;
			var normalJS = null;

			socket.emit('log', "Trying to get " + url);
			request.get(url, function(error, response, body) {
				minifiedJS = body;

				var regex = /\/\/# sourceMappingURL=(.*)/gmi;

				if (error || response.statusCode !== 200) {
					socket.emit('log', "Getting " + url + " failed - " + response.statusCode + error);
					console.log("Getting", url, "failed -", response.statusCode, error);
					socket.emit('done');
					return;
				}

				socket.emit('log', "Got " + url + " (" + response.statusCode + ")");
				console.log("Got", url, "(" + response.statusCode + ")");
				var mapFiles = body.match(regex);

				if (!mapFiles) {
					socket.emit('log', 'ERROR: no source map references found');
					socket.emit('done');
					return;
				}

				if (mapFiles.length > 1) {
					socket.emit('log', "ERROR: Too many map files");
					socket.emit('done');
					return;
				}

				var mapUrl = GetMapFileUrl(mapFiles, url);
				socket.emit('log', 'Trying to get map file ' + mapUrl);

				request.get(mapUrl, function(err, response, body) {
					if (err) {
						socket.emit('log', 'ERROR: Couldn\'t get map file, error: ' + response.statusCodee);
						socket.emit('done');
						return;
					}

					socket.emit('log', 'Got the map file');
					sourceMap = body;

					var smc = new SourceMapConsumer(body);

					for (var z = 0; z < smc.sources.length; z++) {
						var scriptName = GetScriptName(url);

						if (scriptName === smc.sources[z]) {
							socket.emit('log', "ERROR: Source map source (" + smc.sources[z] + ") is the same as the script being checked (" + scriptName + "), it shouldn't be");
							socket.emit('done');
							return;
						}
					}

					for (var z = 0; z < smc.sources.length; z++) {
						var sourceFileUrl = GetSourceFileUrl(smc.sources[z], url);
						GetSourceFile(sourceFileUrl, socket);
					}
				});

			});
		});
	});

	function GetSourceFile(sourceFileUrl, socket) {
		request.get(sourceFileUrl, function(err, response, body) {
			if (err || response.statusCode !== 200) {
				if (!response) {
					response = {
						statusCode: 'UNKNOWN'
					};
				}

				socket.emit('log', 'ERROR getting source file: ' + sourceFileUrl + " (" + response.statusCode + ")");
				socket.emit('done');
				return;
			}

			normalJS = body;

			try {
				socket.emit('log', 'Everything looks OK');
				socket.emit('done');
				return;
			} catch (e) {
				console.log("Error");
				console.log(e);
				socket.emit('log', 'ERROR: ' + e);
			}
		});
	}

	app.use(raygunClient.expressHandler);
	http.listen(process.env.PORT || 3000, function() {
		console.log('listening on *:' + (process.env.PORT || 3000));
	});
});
