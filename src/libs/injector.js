const puppeteer = require('puppeteer-core');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios').default;
const logger = require('./log');
const path = require('path');
const fs = require('fs');

module.exports = class borealisInjector {
    constructor() {
        this.log = new logger('Injector');
        this.filesToPatch = [
            'steamui/sp.js',
            'steamui/libraryroot~sp.js',
            'steamui/index.html'
        ];
    }

    detectSteamInstall() {
        let locations = [
            'C:/Program Files (x86)/Steam/',
            '/home/deck/.steam/steam'
        ]
    
        let detectedLocation = false;
    
        // Check all locations
        locations.forEach(element => {
            try {
                fs.accessSync(element)
                fs.accessSync(path.resolve(element, 'steamui/sp.js'));
                fs.accessSync(path.resolve(element, 'steamui/libraryroot~sp.js'));
                detectedLocation = element;
            } catch (err) {
                return;
            }
        })

        return detectedLocation;
    }

    async getCEFData() {
        for (let i = 0; i < 4; i++) {
            this.log.info(`Attempting to get CEF Data, Attempt ${i + 1} of 5`)
    
            let response = await axios.get("http://localhost:8080/json/version", {validateStatus: () => true}).then(
                data => data.data
            ).catch((err) => {
                this.log.warning('Something went wrong attempt to contact debugger, retrying in 5 seconds...');
                return false;
            });
    
            if (response !== false) {
                return response
            } else {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    
        throw new Error('Failed to get CEF Data after 5 tries. Not attempting again.');
    }

    loadPatchFiles() {
        this.patches = [];
        fs.readdirSync('./src/patches').forEach(file => {
            if (!file.endsWith('.js')) {
                return;
            } else {
                this.patches.push(new (require(path.resolve('./src/patches/', file)))());
            }
        })
    }

    patchFile(file, steamInstall) {
        this.patches.forEach(patch => {
            patch.getPatchFiles().forEach(patchFile => {
                if (file.endsWith(patchFile)) {
                    patch.patch(file, steamInstall);
                }
            })
        })
    }

    async inject() {
        // Step 1, Patch all client files that need patching.
        const steamInstall = this.detectSteamInstall();

        this.loadPatchFiles();

        this.backups = [];

        this.filesToPatch.forEach(file => {
            this.backups.push({
                directory: path.resolve(steamInstall, file),
                content: fs.readFileSync(path.resolve(steamInstall, file))
            });

            this.log.info('Patching File: ' + file);
            this.patchFile(path.resolve(steamInstall, file), steamInstall);
        })


        // Step 2, check if steam is running and willing to accept connections
        while (true) {
            if (!isSteamRunning()) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                break;
            }
        }

        this.log.info('Steam is running! Attempting to connect...')

        let cefdata = await this.getCEFData();

        // Hook Browser Instance

        for (let i = 0; i < 5; i++) {
            let connectSuccess = await puppeteer.connect({
                browserWSEndpoint: cefdata.webSocketDebuggerUrl,
                defaultViewport: null
            }).then((instance) => {
                this.log.info('Successfully hooked CEF.')
                this.browserInstance = instance;
                return true;
            }).catch((err) => {
                this.log.warning('Failed to hook CEF, waiting 5 seconds then trying again.');
                return false;
            })

            if (connectSuccess) {
                break;
            } else {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        let pages = await this.browserInstance.pages();
        this.instance = null;

        await Promise.all(pages.map(async (page) => {
            let title = await page.title();
            if (title !== 'SP') {
                return;
            }
            await page.reload();
            this.log.info('Finished All Stages, BorealisOS is loaded.');
            this.instance = page;
        }));
    }

    async uninject() {
        // Restore all files.
        this.backups.forEach(file => {
            fs.writeFileSync(file.directory, file.content);
            this.log.info('Restored original file: ' + file.directory);
        })

        this.instance.reload();
    }
}

// Check if steam is running
const isSteamRunning = async () => {
    let command = `pgrep steamwebhelper`;
    let response = await exec(command);
    if (response.stdout.length !== 0) {
        return true
    }
}