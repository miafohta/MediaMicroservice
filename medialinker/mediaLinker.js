#!/usr/bin/env node

'use strict';

const _ = require('lodash');
const fs = require('fs');
const program = require('commander');
const logger = require('../lib/logger').NewLogger({
    label: 'mediaLinker'
});

const mediaLinkerWorker = require('../workers/medialinker');
let siteConfFile; // set with the `${program.confpath}/siteConf.js`

program
    .version('0.1.0')
    .option('-s, --siteid [INTEGER]', 'Site ID')
    //.option('-m, --movieid [string]', 'process only this movie_date_id, example "--movieid 200 -l 0", the -l 0 tells it to not look at the updated field')
    .option('-a, --smid [INTEGER]', 'Source Movie ID')
    .option('-b, --dmid [INTEGER]', 'Destination Movie ID')
    .option('-r, --rows [INTEGER]', 'Tells mediaInfoWoker to only process this many movies at a time. Defaults is 100')
    .option('-p, --confpath [string]', 'path to the configuration where the site confs are /path/to/config/, in this dir, will be dirs by siteConf.js')
    .option('-l, --lastupdated [INTEGER]', 'last updated, hours ago. -l 2 will get movies updated 2 hours ago... set to 0, to processes all movies.')
    .parse(process.argv);

logger.info("Starting - mediaLinker.js");

// Site Id is required for any process ( by site or by movie)
if (!program.siteid) {
    logger.error("Site ID is required. Use -s --siteid to process");
    process.exit();
}

// Check our site configuration directory.
if (!program.confpath) {
    logger.error("Configuration path is required. Use -p or --confpath /pathto/config");
    process.exit();
} else {
    // Site config file
    siteConfFile = `${program.confpath}/siteConf.js`;

    // check if file exists.
    try {
        fs.accessSync(siteConfFile, fs.constants.R_OK);
    } catch (err) {
        console.error("Error:", err);
        process.exit();
    }
}

//Check movie directories exsist in the config.
         

logger.info(`Using configuration file: ${siteConfFile}`);

Main();
function Main() {
    let config = require(siteConfFile);
    let site_id = program.siteid;
    let lastUpdated = 24; 
    let rowCount = 100;
    let sourceMovieId = 0
    let destMovieId = 0;

    logger.info('main started');
    if (!_.isEmpty(program.lastupdated)) {
        lastUpdated = _.toNumber(program.lastupdated);
        if (_.isNaN(lastUpdated)) {
            lastUpdated = 24;
        }
    }
    if (!_.isEmpty(program.rows)) {
        rowCount = _.toNumber(program.rows);
        if (_.isNaN(rowCount)) {
            rowCount = 100;
        }
    }
    if (!_.isEmpty(program.smid)) {
        sourceMovieId = _.toNumber(program.smid);
        if (_.isNaN(sourceMovieId)) {
            sourceMovieId = 0;
        }
    }
 
    if(!_.isEmpty(program.dmid)) {
        destMovieId = _.toNumber(program.dmid);
        if(_.isNaN(destMovieId)) {
            destMovieId = 0;
        }
    }

    if (site_id > 0) {
        (async () => {
            try {
                // if siteID does not exist in config will get an error
                let siteID = await config.getSiteID(site_id);
                let siteConfig = config.get();
                let params = {};

                params['logger'] = logger; 
                params['smid'] = sourceMovieId;
                params['dmid'] = destMovieId;
                params['lastUpdated'] = lastUpdated;  
                params['processRowsCount'] = rowCount;

                let mdl = new mediaLinkerWorker(siteID, siteConfig, params);
                await mdl.ProcessSite();

            } catch (err) {
                logger.warn(`error: ${err}`);
            }
        })();
    } else {
        logger.info('No site ID in config');
    }
}
