/* global process, Promise, before, after */
// eslint-disable-next-line import/no-extraneous-dependencies
const puppeteer = require('puppeteer');
const { fork } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

// We could run 'npm start' to serve itowns for the tests,
// but it's slow to start (so tests might fail on timeouts).
// Since the 'test-examples' target depends on the 'run' target,
// we instead run the simplest http server.
// It needs to be forked, so it's written to a temp file before
// running.
const simplestHttpServer = `
    const http = require('http');
    const fs = require('fs');

    const ext2mime = new Map();
    ext2mime.set('html', 'text/html');
    ext2mime.set('js', 'text/javascript');
    ext2mime.set('css', 'text/css');
    ext2mime.set('json', 'application/json');

    const server = http.createServer(function(req, res) {
      const file = './' + req.url;
      fs.readFile(file, function(err, data) {
        if (err) {
          res.writeHead(500);
        }
        else {
          const extension = file.substr(file.lastIndexOf('.') + 1);
          if (ext2mime.has(extension)) {
            res.writeHead(200, { 'Content-Type': ext2mime.get(extension)});
          }
          res.end(data);
        }
      });
    });

    server.listen(process.argv[2]);
`;

function _waitServerReady(port, resolve) {
    const client = net.createConnection({ port }, () => {
        resolve(true);
    });
    client.on('error', () => {
        setTimeout(() => {
            _waitServerReady(port, resolve);
        }, 100);
    });
}

function waitServerReady(port) {
    return new Promise((resolve) => {
        _waitServerReady(port, resolve);
    });
}

function findFreeTcpPort(startPort) {
    function _test(port, resolve) {
        const client = net.createConnection({ port });
        client.on('connect', () => {
            client.end();
            _test(port + 1, resolve);
        });
        client.on('error', () => {
            resolve(port);
        });
    }
    return new Promise((resolve) => {
        _test(startPort, resolve);
    });
}

before(async () => {
    let port = 8080;

    if (!process.env.USE_DEV_SERVER) {
        port = await findFreeTcpPort(port);
        console.log(`Starting itowns on port ${port}`);

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'itowns-'));
        const file = `${folder}/server.js`;
        fs.writeFileSync(file, simplestHttpServer);
        global.itownsProcess = fork(file, [port.toString()]);
    } else {
        port = process.env.USE_DEV_SERVER;
    }

    // wait for port 8080 to be ready
    await waitServerReady(port);

    global.itownsPort = port;

    global.printLogs = (page) => {
        page.on('console', (msg) => {
            for (let i = 0; i < msg.args().length; ++i) {
                console.log(`${msg.args()[i]}`);
            }
        });
    };

    global.waitNextRender = page =>
        page.evaluate(() => new Promise((resolve) => {
            function getView() {
                if (typeof (view) === 'object') {
                    return Promise.resolve(view);
                }
                if (typeof (globeView) === 'object') {
                    return Promise.resolve(globeView);
                }
                return undefined;
            }

            getView().then((v) => {
                function resolveWhenDrawn() {
                    v.removeFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, resolveWhenDrawn);

                    // make sure the loading screen is hidden
                    const container = document.getElementById('itowns-loader');
                    if (container) {
                        container.style.display = 'none';
                    }
                    resolve();
                }
                v.addFrameRequester(itowns.MAIN_LOOP_EVENTS.AFTER_RENDER, resolveWhenDrawn);
                v.notifyChange(true);
            });
        }));

    // Helper function: returns true when all layers are
    // ready and rendering has been done
    global.exampleCanRenderTest = async (page, screenshotName) => {
        const result = await page.evaluate(() => new Promise((resolve) => {
            function getView() {
                if (typeof (view) === 'object') {
                    return Promise.resolve(view);
                }
                if (typeof (globeView) === 'object') {
                    return Promise.resolve(globeView);
                }
                resolve(false);
                return Promise.reject();
            }

            getView().then((v) => {
                function resolveWhenReady() {
                    v.removeEventListener(itowns.VIEW_EVENTS.LAYERS_INITIALIZED, resolveWhenReady);
                    resolve(true);
                }
                v.addEventListener(itowns.VIEW_EVENTS.LAYERS_INITIALIZED, resolveWhenReady);
            });
        }));

        if (process.env.SCREENSHOT_FOLDER) {
            await waitNextRender(page);

            const sanitized = screenshotName.replace(/[^\w]/g, '_');
            const file = `${process.env.SCREENSHOT_FOLDER}/${sanitized}.png`;
            await page.screenshot({ path: file });
            console.log('Wrote ', file);
        }

        return result;
    };
    global.browser = await puppeteer.launch({
        executablePath: process.env.CHROME,
        headless: !process.env.DEBUG,
        devtools: !!process.env.DEBUG,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] });
});

// close browser and reset global variables
after(() => {
    global.browser.close();
    if (global.itownsProcess) {
        // stop itowns
        process.kill(global.itownsProcess.pid);
    }
});

