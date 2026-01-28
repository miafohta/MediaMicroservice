#!/usr/bin/env node

'use strict';

const _ = require('lodash');
const fs = require('fs');
const lockFile = require('lockfile');
const program = require('commander');
const logger = require('../lib/logger').NewLogger({
    label: 'mediaInfo'
});

const mediaInfoWorker = require('../workers/mediainfo');
let siteConfFile; // set with the `${program.confpath}/${program.siteid}/siteConf.js`

program
    .version('0.1.0')
    .option('-s, --siteid [INTEGER]', 'Site ID')
    .option('-m, --movieid [INTEGER]', 'process only this movie_id, example "--movieid 200 -l 0", the -l 0 tells it to not look at the updated field')
    .option('-p, --confpath [string]', 'path to the configuration where the site confs are /path/to/config/, in this dir, will be dirs by siteID xxxx/siteConf.js, xxxx/siteConf.js.')
    .option('-l, --lastupdated [INTEGER]', 'last updated, hours ago. -l 2 will get movies updated 2 hours ago... set to 0, to processes all movies.')
    .option('-r, --rows [INTEGER]', 'Tells mediaInfoWoker to only process this many movies at a time. Defaults is 100')
    .option('-t, --dirtype [string]', `defaults to all, for movies can specify one of 'sample' or 'member', for thumbnails specify 'thumbnails' or 'image'`)
    .option('-x, --maxffprobe [INTEGER]', `set max ffprobe processes that can run, default is set to the number of cpus on the system.`)
    .option('-d, --released [INTEGER]', `process released movies -d (--released) Number of days ago, to make sure we didn't miss them during the regular processing`)
    .parse(process.argv);

logger.info("Starting - mediaInfo.js");

let lockFileOptions = {
    stale: 1000 * 3600 // (3600 sec is 60min) in milliseconds before locks are considered to be expired.
    // NOTE: processes that try to run will know that the lock file,
    // if exists is stale after this many milliseonds and will clean
    // it up.
};

if (!program.siteid) {
    logger.error("SiteID not specified. Use -s or --siteid flags to specify a site id to process.");
    process.exit();
}

// Check our site configuration directory.
if (!program.confpath) {
    // NOTE:
    // Inside this configuration path should be one directory per siteID
    // i.e /path/to/config/[SITEID]/
    // inside the SITEID dir will be the configuration file, we specifically look for 
    // /path/to/config/[SITEID]/siteConf.js [SITEID] is for example xxxx
    // so will look like /path/to/config/xxxx/
    // and the path to the config file is /path/to/config/xxxx/siteConf.js
    logger.error("Configuration path is required. Use -p or --confpath /path/to/config");
    process.exit();
} else {
    // Site config file
    siteConfFile = `${program.confpath}/${program.siteid}/siteConf.js`;

    // check if file exists.
    try {
        fs.accessSync(siteConfFile, fs.constants.R_OK);
    } catch (err) {
        console.error("Error:", err);
        process.exit();
    }
}

logger.info(`Using configuration file: ${siteConfFile}`);
let lockfilename = `lockfile.mediaInfo.${program.siteid}`;

//  Create a separate lock file for program.released
//  When we use the program.released flag we're just
//  telling this program to only processed released movies
//  and we want this to be able to run anytime we want even
//  if the normal process is running that only checks last updated
//  movies.
if (program.released) {
    lockfilename = lockfilename + `.released.${program.released}`;
}

// Create a separate lock file for
// when this program runs to process ALL movies
if (!_.isEmpty(program.lastupdated)) {
    let last = _.toNumber(program.lastupdated);

    if (last === 0) {
        lockfilename = lockfilename + `.lastUpdated.0.ALL`;
    }
}

logger.info(`LOCKFILENAME: ${lockfilename}`);

lockFile.lock(lockfilename, lockFileOptions, function (err) {
    if (err) {
        logger.error("Error getting lockfile.");
        return;
    }

    Main(function () {
        lockFile.unlock(lockfilename);
        process.exit();
    });
});

function Main(unlockFileFNC) {
    let config = require(siteConfFile);
    let site_id = program.siteid;
    let lastUpdated = 2; // default to get movie rows updated 2 hours ago.
    let rowCount = 100; // default to go tell mediaInfoWorker to go/step through 100 rows of movies at a time, regardless of the amount of rows returned.
    let movie_id;

    if (!_.isEmpty(program.lastupdated)) {
        lastUpdated = _.toNumber(program.lastupdated);
        if (_.isNaN(lastUpdated)) {
            lastUpdated = 2;
        }
    }
    if (!_.isEmpty(program.rows)) {
        rowCount = _.toNumber(program.rows);
        if (_.isNaN(rowCount)) {
            rowCount = 100;
        }
    }
    if (!_.isEmpty(program.movieid)) {
        movie_id = _.toNumber(program.movieid);
    }

    if (site_id > 0) {
        (async () => {
            try {
                // if siteID does not exist in config will get an error
                let siteID = await config.getSiteID(site_id);
                let siteConfig = config.get();
                let params = {};
                params['processRowsCount'] = rowCount;
                params['lastUpdated'] = lastUpdated;
                if (!_.isNaN(movie_id) && movie_id > 0) {
                    params['movie_id'] = movie_id;
                }

                // TODO: validaty dirtype argument...
                if (!_.isEmpty(program.dirtype)) params['dirtype'] = program.dirtype;

                if (!_.isEmpty(program.released)) {
                    params['approved_released_days_ago'] = program.released;
                }

                params['logger'] = logger; // set mediainfo logger to our logger.

                if (program.maxffprobe > 0) {
                    params['maxffprobe'] = program.maxffprobe;
                }

                await mediaInfoWorker.ProcessSite(siteID, siteConfig, params);
                logger.info(`Import Image Thumbnail Count: ${mediaInfoWorker.Count.NewThumbnails}`);
                logger.info(`Import Movie Count: ${mediaInfoWorker.Count.NewMovies}`);
                logger.info(`Import Sample Movie Count: ${mediaInfoWorker.Count.NewSampleMovies}`);
                logger.info(`Update Image Thumbnail Count: ${mediaInfoWorker.Count.UpdatedThumbnails}`);
                logger.info(`Update Movie Count: ${mediaInfoWorker.Count.UpdatedMovies}`);
                logger.info(`Update Sample Movie Count: ${mediaInfoWorker.Count.UpdatedSampleMovies}`);
                logger.info(`Update Movie Status Deleted Count: ${mediaInfoWorker.Count.StatusDeletedMovies}`);
                logger.info(`Update Thumbnail Status Deleted Count: ${mediaInfoWorker.Count.StatusDeletedThumbnails}`);

                mediaInfoWorker.models.DB.close();
                unlockFileFNC();
            } catch (err) {
                logger.warn(`error: ${err}`);
                unlockFileFNC();
            }
        })();
    }
}