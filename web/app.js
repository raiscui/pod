var http     = require('http'),
    fs       = require('fs'),
    path     = require('path'),
    spawn    = require('child_process').spawn,
    express  = require('express'),
    pod      = require('../lib/api'),
    connect  = require('connect'),
    app      = express()

// late def, wait until pod is ready
var conf

// middlewares
var reloadConf = function (req, res, next) {
    conf = pod.reloadConfig()
    next()
}

var auth = express.basicAuth(function (user, pass) {
  // Disabling auth
  return true;
  //   var u = conf.web.username || 'admin',
  //      p = conf.web.password || 'admin'
  //  return user === u && pass === p
})

app.configure(function(){
    app.set('views', __dirname + '/views')
    app.set('view engine', 'ejs')
    app.use(express.favicon())
    app.use(express.json());
    app.use(express.urlencoded());
    app.use(reloadConf)
    app.use(app.router)
    app.use(express.static(path.join(__dirname, 'static')))
})

app.get('/', auth, function (req, res) {
    pod.listApps(function (err, list) {
        if (err) return res.end(err)
        res.render('index', {
            apps: list
        })
    })
})

app.get('/json', auth, function (req, res) {
    pod.listApps(function (err, list) {
        if (err) return res.end(err)
        res.json(list)
    })
})

app.post('/hooks/:appid',  function (req, res) {
    var appid = req.params.appid,
        payload = JSON.stringify(req.body),
        app = conf.apps[appid];

    console.log('Try parse incoming json');
    try {
        payload = JSON.parse(payload)
    } catch (e) {
        return res.end(e.toString())
    }
    console.log('parsed json');
    if (app && verify(req, app, payload)) {
        executeHook(appid, app, payload, function (err) {
            res.end(err || "Success")
        })
    } else {
        res.end("Ignoring commit")
    }
})

// listen when API is ready
pod.once('ready', function () {
    // load config first
    conf = pod.getConfig()
    // conditional open up jsonp based on config
    if (conf.web.jsonp === true) {
        app.get('/jsonp', function (req, res) {
            pod.listApps(function (err, list) {
                if (err) return res.end(err)
                res.jsonp(list)
            })
        })
    }
    app.listen(process.env.PORT || 19999, process.env.POD_BIND_ADDR)
})

// Helpers
function verify (req, app, payload) {
    // not even a remote app
    if (!app.remote) return
    // check repo match
    var repo = payload.repository
    console.log('\nreceived webhook request from: ' + repo.url)
    if (strip(repo.url) !== strip(app.remote)) {
        console.log('aborted.')
        return
    }
    // skip it with [Ignore Deploy] message
    var commit = payload.head_commit
    console.log('commit message: ' + commit.message)
    if (/\[Ignore Deploy\]/.test(commit.message)) {
        console.log('aborted.')
        return
    }
    // check branch match
    var branch = payload.ref.replace('refs/heads/', ''),
        expected = app.branch || 'master'
    console.log('expected branch: ' + expected + ', got branch: ' + branch)
    if (branch !== expected) {
        console.log('aborted.')
        return
    }
    return true
}

function executeHook (appid, app, payload, cb) {
    fs.readFile(path.resolve(__dirname, '../hooks/post-receive'), 'utf-8', function (err, template) {
        if (err) return cb(err)
        var hookPath = conf.root + '/temphook.sh',
            hook = template
                .replace(/\{\{pod_dir\}\}/g, conf.root)
                .replace(/\{\{app\}\}/g, appid)
        if (app.branch) {
            hook = hook.replace('origin/master', 'origin/' + app.branch)
        }
        fs.writeFile(hookPath, hook, function (err) {
            if (err) return cb(err)
            fs.chmod(hookPath, '0777', function (err) {
                if (err) return cb(err)
                console.log('excuting github webhook for ' + appid + '...')
                var child = spawn('bash', [hookPath])
                child.stdout.pipe(process.stdout)
                child.stderr.pipe(process.stderr)
                child.on('exit', function (code) {
                    fs.unlink(hookPath, cb)
                })
            })
        })
    })
}

function strip (url) {
    return url.replace(/^(https?:\/\/|git@)github\.com(\/|:)|\.git$/g, '')
}
