'use strict';

const {
    Op
} = require("sequelize");

const _ = require('lodash');
//const async = require('async');
const moment = require('moment');
const modelHelper = require('../helpers/getModels');
const getFiles = require('../lib/getfiles');
const path = require('path');
const util = require('util');
const fs = require('fs');
const ffmpeg = require('../lib/ffmpeg');
let logger = require('../lib/logger').NewLogger({
    label: 'MediaInfoWorker'
});

// TODO: when we change legacy to new reup admin set to true
// or remove the logic to check these constants.
// Set to false, till we migrate to reupdb from legacy
const UPDATE_MOVIE_DURATION = true;
const UPDATE_HAS_FLASH_IMAGE = true;

// if true logs info if the movie directory doesn't exists yet.
const WARN_DIR_NOT_EXISTS = false;


// See the MediaInfo.getStatus() function
const STATUS_RELEASED = 1; // The status number we give to a file if the movie is released
const STATUS_NOTRELEASED = 2; // The status number we give to a file if the movie is not yet released 

// This is the status we give in the DB if a previously known 
// file, no longer exists on the file system.
const STATUS_FILEDELETED = 0;
let sitesConfig = {};

// regex to replace with movie_date_id in the configuration paths.
const MOVIE_REGEX = /#MOVIE_ID#/;

// uriPathFilter
// @param {string} fpath - - the file path of the file to filter out the uri path from a docroot dir.
// @param {Array} docroots - list of directories representing the doc roots
// uriPathFilter
// Takes a file path as in: 
//   fpath = '/Users/xxxxxxx/tmp/www/html/movie/member/file1.mp4'
//
// A list of docroot paths as in:
// docroot = [
//     '/Users/xxxxxxx/tmp/www/html',
//     '/Users/xxxxxxx/tmp/www/html2', // etc..
// ]
//
// What this function does is it determins and returns the 'uri' part from the file path.
// It loops through the docroot dir lists:
// 
// If it finds a matching prefix part of the path from the file path.
// Example:
//   fpath is '/Users/xxxxxxx/tmp/www/html/movie/member/file1.mp4'
//   docroot[0] is '/Users/xxxxxxx/tmp/www/html'
// It will extract the part from the fpath after the '/Users/xxxxxxx/tmp/www/html'
// in this case '/movie/member/file1.mp4' and considers this the uri path and returns
// it to the caller.
// @returns - a promise representing the uri path string.
function uriPathFilter(fpath, docroots = []) {
    return new Promise((resolve, reject) => {
        let tmpUriPath = [];
        let newUri = '';

        fpath = path.normalize(fpath.trim());
        fpath = fpath.replace(/^\/|\/$/g, ""); // remove leading/trailing slash
        let fp = fpath.split(path.sep);

        for (let rootPath of docroots) {
            rootPath = path.normalize(rootPath.trim());
            rootPath = rootPath.replace(/^\/|\/$/g, ""); // remove leading/trailing slash
            let droot = rootPath.split(path.sep);

            // If any of the parent dirs of the docroot
            // doesn't match, it's not the doc root. So we skip it.
            let nomatch = false;
            for (let j = 0; j < droot.length; j++) {
                if (fp[j] !== droot[j]) {
                    nomatch = true;
                }
            }

            if (nomatch) continue; // we determined, we're not the docroot. so skip.

            for (let i = 0; i < fp.length; i++) {
                if (fp[i] == droot[i]) continue; // skip first parts of docroot.

                tmpUriPath.push(fp[i]);
            }

            // If we got here then we already have the uri in tmpUriPath no need to get
            // it from another docroot match.
            break;
        }

        newUri = tmpUriPath.join(path.sep);
        if (newUri != "") {
            newUri = "/" + newUri; // add leading slash back
        }

        resolve(newUri);
    });
}

// getURIPath function
// @param {number} siteID - site's site id, used to get the sites 'docroots' paths from the config.
// @param {string} filePath - file's full path on the file system.
//
// Extracts the URI path from the "file" path.
// The uri path part is filtered out from the "docroot" paths configured in the sitesConfig.
//
// So for example if the docroot array has "/www/xxxxxxx.tv/html" in it
// and the file path is "/www/xxxxxxx.tv/html/member/movies/#MOVIE_ID#/1080p.mp4"
//
// It filters out the "docroot" part of the file path and returns just the part
// after the /www/xxxxxxx.tv/html/["THIS Part is the URI Path to return."]/ path.
// @returns {Promise} representing the "URI" string filtered out from the docroots dir.
function getURIPath(siteID, filePath) {
    let docroots = sitesConfig[siteID]['docroots'];

    return new Promise(async (resolve, reject) => {
        let uri = await uriPathFilter(filePath, docroots);
        resolve(uri);
    });
}

// @class MediaInfoWorker
class MediaInfoWorker {
    constructor(site_id, movie, moviePaths, thumbnailPaths) {
        this.movie = movie;
        this.siteID = site_id;
        this.moviePaths = moviePaths;
        this.thumbnailPaths = thumbnailPaths;
    }
    importImages() {
        let dirType = 'image';
        return MediaInfoWorker.importFiles(this.siteID, this.movie, this.thumbnailPaths, dirType);
    }
    updateFlashImageFlag() {
        return new Promise(async (resolve, reject) => {
            let filesConfig = {};
            let flash_images = sitesConfig[this.siteID]['flash_image'];

            // populate filesConfig[fname] so we can know what files are flash images
            for (let key of _.keys(flash_images)) {
                let fname = path.basename(key); // extract the filename out of the path.
                filesConfig[fname] = {
                    'isFlash': true,
                    'value': flash_images[key], // the order of priority for this file 1 is the highest
                };
            }

            let model_name = {
                'thumbnails': {
                    // Our model name see ../models/reupTarThumbnails.js
                    'modelName': 'reupTarThumbnails',
                    // SELECT column names
                    'attr': ['file_number', 'movie_id', 'path', 'flashimage_flag', 'status'],
                },
            };

            let type = 'thumbnails';
            let useModel = model_name[type]['modelName'];
            let attributes = model_name[type]['attr']; // column names

            let movieModel = MediaInfoWorker.models['movies']; // get the movies model
            let model = MediaInfoWorker.models[useModel]; // the reupTarThumbnails model

            movieModel.hasMany(model, {
                foreignKey: 'movie_id'
            });
            model.belongsTo(movieModel, {
                foreignKey: 'movie_id'
            });

            let criteria = {
                'attributes': attributes,
                'where': {
                    'movie_id': this.movie.movie_id,
                },
                'include': [{
                    model: movieModel,
                    attributes: ['site_id', 'movie_date_id']
                }],
            };

            let data = await model.findAll(criteria);

            let flashImages = [];
            await (() => Promise.all(data.map(row => {
                return new Promise(async (res, rej) => {
                    let flashimageFlagPriority = await MediaInfoWorker.getFlag(
                        this.siteID, row.path,
                        this.movie.movie_date_id,
                        'flash_image'
                    );
                    if (flashimageFlagPriority == 0) return res();

                    // logger.info(`Thumbnails: fn: ${row.file_number}, path: ${row.path}, flash: ${row.flashimage_flag}, isFlash: ${flashimageFlagPriority}`);

                    flashImages.push({
                        'file_number': row.file_number,
                        'priority': flashimageFlagPriority,
                        'path': row.path,
                        'flashimage_flag': row.flashimage_flag
                    });
                    return res();
                });
            })))();

            // No flashimages found so return.
            if (!flashImages || !flashImages.length) {
                return resolve();
            }

            // Let's now examine flashImages[] array
            // and if there's more then 1 flashimages detected
            // we have to choose the one with the highest priority
            // to set in the db the flashimage_flag = 1 and
            // if for some reason the one with the lower priority is already set
            // we have to set that to 0 since we found a higher priorty flash image.
            await (() => new Promise(async (res, rej) => {
                //if (flashImages.length > 1) {
                //    console.log(`DEBUG: We have more than one flash image (${flashImages.length}) found, need to choose ONE`);
                //}
                // Sort flashImages by priority

                flashImages.sort((a, b) => (a.priority > b.priority) ? 1 : -1);
                // console.log("DEBUG:", flashImages);
                /* prints
                DEBUG: [
                    { file_number: 25,
                      priority: 1,
                      path: '/moviepages/122818_788/images/str.jpg',
                      flashimage_flag: 0 },
                    { file_number: 24,
                      priority: 2,
                      path: '/moviepages/122818_788/images/popu.jpg',
                      flashimage_flag: 0 }
                ]
                */

                try {
                    await MediaInfoWorker.models.DB.transaction(async (trx) => {
                        // get the first image to set flag to 1 if it's not already set.
                        let thumb = flashImages[0];
                        // console.log("FIRST FLASH IMAGE: (1)", thumb);
                        if (thumb.flashimage_flag != 1) {
                            let rec = await MediaInfoWorker.models[useModel].findByPk(
                                thumb.file_number, {
                                    transaction: trx
                                }
                            );

                            if (rec != null) {
                                let data = {
                                    flashimage_flag: 1
                                };
                                await rec.update(data, {
                                    'fields': _.keys(data),
                                    'transaction': trx,
                                });
                            }

                        }

                        // check the rest of the images
                        // set flashimage_flag to 0 if it's set to 1
                        // skip if it's already set to 0
                        for (let i = 1; i < flashImages.length; i++) {
                            let thumb = flashImages[i];
                            if (thumb.flashimage_flag == 0) continue;
                            //console.log("FLASH IMAGE: (", i + 1, ")", thumb);
                            let rec = await MediaInfoWorker.models[useModel].findByPk(
                                thumb.file_number, {
                                    transaction: trx
                                }
                            );
                            let data = {
                                flashimage_flag: 0
                            };
                            await rec.update(data, {
                                'fields': _.keys(data),
                                'transaction': trx,
                            });
                        }
                    });
                } catch (err) {
                    logger.error(err);
                    return reject(err);
                }

                return res();
            }))();

            return resolve();
        });
    }
    importSampleMovies() {
        let dirType = 'sample';
        return MediaInfoWorker.importFiles(this.siteID, this.movie, this.moviePaths, dirType);
    }
    importMemberMovies() {
        let dirType = 'movies';
        return MediaInfoWorker.importFiles(this.siteID, this.movie, this.moviePaths, dirType);
    }
    static InitDB() {
        return new Promise(async (resolve, rej) => {
            try {
                // console.log("Init() - getting models")
                // models are actually cached so if InitDB() is called multiple
                // times it will return the cached models if it wasn't already intialized.
                MediaInfoWorker.models = await MediaInfoWorker.GetModels({
                    'env': process.env['NODE_ENV'] || 'development'
                });

                // console.log("DEBUG - MediaInfoWorker.models.movies:", MediaInfoWorker.models.movies);
                resolve()
            } catch (err) {
                logger.error(err);
                reject();
            }
        });
    }
    // Configure the models in modelNames 
    // @param {string} nodeEnv - Used to get the db configuration by name. See the 
    // configuration in ../config/dbconfig.js.
    // @returns {Promise} a Promise representing the models object. 
    static GetModels(dbOptions = {}, nodeEnv = process.env['NODE_ENV'] || 'development') {
        return new Promise(async (resolve, reject) => {
            try {
                // GetDbModels caches the models, so if called multiple
                // times it returns the cached model, so it should be okay
                // to call InitDB() or GetModels() multiple times.
                // If there's any issue with the cached models check modelHelper.GetDbModels 
                // function for the logic to ensure the cached model still works..
                let models = await modelHelper.GetDbModels(MediaInfoWorker['modelNames'], nodeEnv, dbOptions);
                MediaInfoWorker.models = models;
                resolve(models);
            } catch (err) {
                reject(err);
            }
        });
    }
    // getMovies(siteID, options = {}) static function:
    // @param {number} - siteid = int the id of the site to get movies for
    // @options {} 
    //  - options.gte_updated_hrs {number} - will get movies where updated >= 'N hrs'::interval
    //  - options.limit {number} - limit number of rows to get
    //  - options.offset {number} - offset, step over the first offset number of rows 
    // NOTE: if options limit is not set it'll return all rows
    //       if gte_updated_hrs is not set or is 0, it'll get all rows
    // @returns {Promise} - promise representing the rows from the database table movie.movies.
    static getMovies(siteid, options = {}) {
        // criteria object
        let cr = {
            site_id: siteid,
        };

        if (options['gte_updated_hrs'] && options['gte_updated_hrs'] > 0) {
            let updated_hrs = options['gte_updated_hrs'];

            // (updated >= time OR release_date >= now()-2hrs)
            cr[Op.or] = [{
                    'updated': {
                        [Op.gte]: moment().subtract(updated_hrs, 'hours').toDate()
                    }
                },
                // Force check files for movies who's release date
                // will be within 2 hours from now.
                // This also ensures we catch movies that, the updated column
                // hasn't changed since and the release_date is coming up.
                {
                    'release_date': {
                        [Op.gte]: moment().subtract(2, 'hours').toDate()
                    }
                }
            ];
        }

        if (options['approved_released_days_ago'] && options['approved_released_days_ago'] > 0) {
            // reset criteria
            let released_days_ago = options['approved_released_days_ago'];
            cr = {};
            cr['site_id'] = siteid;
            cr['release_date'] = {
                '$gte': moment().subtract(released_days_ago, 'days').toDate()
            };
            cr['production_status'] = 'approved';
        }

        // Get by movie_id
        if (options['movie_id'] && options['movie_id'] > 0) {
            cr['movie_id'] = options['movie_id']; // get by movie id.
        }

        let findOptions = {
            attributes: ['movie_id', 'movie_date_id', 'updated', 'site_id', 'production_status', 'duration_seconds', 'has_flash_image', 'release_date', 'expire_date'],
            where: cr, // criteria object
            //order: ['movie_id', 'DESC'] // so we always process the most recent movie_id's first :-)
            order: [
                ['movie_id', 'DESC']
            ] // so we always process the most recent movie_id's first :-)
        };

        if (options['limit'] > 0) findOptions['limit'] = options['limit'];
        if (options['offset'] > 0) findOptions['offset'] = options['offset'];

        return new Promise(async (resolve, reject) => {
            try {
                await MediaInfoWorker.InitDB(); // Sets up and caches models

                let data = await MediaInfoWorker.models['movies'].findAndCountAll(findOptions);

                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    // @param {number} siteID - the sites siteID, used for the getURIPath() call in this function.
    // @param {string[]} dirPaths - directory paths to search for files
    // Find movie files found in all the directories/sub-directories listed in the dirPaths array.
    // If the fileType is an 'image' it will skip that file. This is decided in the getFiles.fileType function call.
    // @returns {Promise} - a promise representing the files with media info found on it.
    // if the file does not exists it will skip it, if the file has no media info or the ffprobe call fails
    // to get data for it, it will skip it as well.
    static getMovieFiles(siteID, dirPaths, dirType) {
        if (dirType == 'image') {
            return MediaInfoWorker.getThumbnailFiles(siteID, dirPaths);
        } else {
            return new Promise(async (resolve, reject) => {
                // Get all files in the directory path.
                let files = [];
                await Promise.all(dirPaths.map(async (path) => {
                    try {
                        // get member movie files
                        let ignoreFiles = []; // empty at first

                        if (_.has(sitesConfig[siteID], 'ignore_files')) {
                            if (_.isArray(sitesConfig[siteID]['ignore_files'])) {
                                // assign ignoreFiles to the configuration
                                ignoreFiles = sitesConfig[siteID]['ignore_files'];
                            }
                        }

                        let movieFiles = await MediaInfoWorker.getFiles(path, ignoreFiles);

                        // Filter out image files
                        for (let file of movieFiles) {
                            let ft = await getFiles.fileType(file);
                            if (ft == 'image') continue;

                            files = [].concat.apply(files, [file]);
                        }
                    } catch (err) {
                        // just log error and skip adding the file to the files[] array
                        logger.error(`getMovieFiles: ${err}`);
                    }
                }));

                // Get the media info data for each file.
                let mediaInfo = await Promise.all(files.map((file) => {
                    return new Promise(async (resolve, reject) => {
                        try {
                            let fileType = await getFiles.fileType(file);
                            let minfo = await ffmpeg.ffprobe(file);
                            let uriPath = await getURIPath(siteID, file);

                            minfo['uri_path'] = uriPath;
                            minfo['file_type'] = fileType;
                            resolve(minfo);
                        } catch (err) {
                            logger.error(`getMovieFiles: ${err}`);
                            resolve({}); // resolve with an empty object.
                        }
                    });
                }));

                resolve(mediaInfo);
            });
        }
    }
    // @param {number} siteID - the sites siteID, used for the getURIPath() call in this function.
    // @param {string[]} dirPaths - directory paths to search for files
    // Find movie thumbnail/image files found in all the directories/sub-directories listed in the dirPaths array.
    // @returns {Promise} - a promise representing the files with media info found on it.
    // if the file do not exists it will skip it, if the file has no media info or the ffprobe call fails
    // to get data for it, it will skip it as well.
    static getThumbnailFiles(siteID, dirPaths) {
        // Holds info on which files to import by filename
        // and if file is 'primary' or 'flash
        let filesConfig = {};
        let flash_images = sitesConfig[siteID]['flash_image'];
        let primary_images = sitesConfig[siteID]['image_primary'];

        // populate filesConfig[fname] so we can know what files are primary images
        for (let key of _.keys(primary_images)) {
            let fname = path.basename(key); // extract the filename out of the path.
            filesConfig[fname] = {
                'isPrimary': true,
                'value': primary_images[key], // 1 or 2 
            };
        }

        // populate filesConfig[fname] so we can know what files are flash images
        for (let key of _.keys(flash_images)) {
            let fname = path.basename(key); // extract the filename out of the path.
            filesConfig[fname] = {
                'isPrimary': false,
                'isFlash': true,
                'value': 0,
            };
        }

        return new Promise(async (resolve, reject) => {
            // Get all files in the directory path.
            let files = [];

            // Populate the files[] array with files
            // returned from the getFiles(DIRPATH) function.
            // And filters out non image files
            await Promise.all(dirPaths.map(async (dpath) => {
                try {
                    let thumbFiles = await MediaInfoWorker.getFiles(dpath);

                    // Filter out non image files
                    for (let file of thumbFiles) {
                        let ft = await getFiles.fileType(file);
                        if (ft != 'image') continue;

                        files = [].concat.apply(files, [file]);
                    }
                } catch (err) {
                    // just log error and skip adding the file to the files[] array
                    logger.error(`getThumbnailFiles: ${err}`);
                }
            }));

            // Get the media info data for each file in the files[] array.
            let mediaInfo = await Promise.all(files.map((file) => {
                return new Promise(async (resolve, reject) => {
                    try {
                        let fileType = await getFiles.fileType(file);
                        let finfo = await getFiles.fileInfo(file);
                        let minfo = {};

                        // if fileSize == 0 then we can't use ffprobe on it.
                        // so we'll just set some defaults to these properties.
                        if (finfo.fileSize == 0) {
                            minfo['width'] = 0;
                            minfo['height'] = 0;
                            minfo['file_path'] = file;
                            minfo['file_size'] = finfo.fileSize;
                        } else {
                            minfo = await ffmpeg.ffprobe(file);
                        }

                        let uriPath = await getURIPath(siteID, file);
                        let md5hash = await getFiles.md5(file);
                        minfo['md5'] = md5hash;
                        minfo['uri_path'] = uriPath;
                        minfo['file_type'] = fileType;
                        resolve(minfo);
                    } catch (err) {
                        logger.error(`getThumbnailFiles: ${err}`);
                        resolve({}); // resolve empty object
                    }
                });
            }));

            resolve(mediaInfo);
        });
    }
    // Gets the image_primary flag value from the sitesConfig
    // @param {number} siteID - the site id to get the config from
    // @param {string} uriPath - the uri path to use as the key to get the value from the configuration
    // @param {string} movieDateID - the movie id to use to replace the #MOVIE_ID# using the regex in the config.
    // @param {stirng} flag - 'flash_image' | 'image_primary'
    // @returns {Promise} - a Promise representing the value of the image_primary or flashimage_flag config option
    static getFlag(siteID, uriPath, movieDateID, flag) {
        return new Promise((resolve, reject) => {
            if (_.isEmpty(sitesConfig[siteID])) {
                return reject(new Error(`${siteID} does not exists in sitesConfig config`));
            }

            if (_.has(sitesConfig[siteID], flag) && _.isObject(sitesConfig[siteID][flag])) {
                let flagOptions = {};

                for (let key of _.keys(sitesConfig[siteID][flag])) {
                    let flagKey = key.replace(MOVIE_REGEX, movieDateID);
                    flagOptions[flagKey] = sitesConfig[siteID][flag][key];
                }

                //console.log('FlagOptions:', flagOptions);
                if (flagOptions[uriPath] == undefined) {
                    return resolve(0);
                }

                resolve(flagOptions[uriPath]);
            } else {
                resolve(0);
            }
        });
    }
    // Returns a promise with the file paths found in a directory and it's sub-directories.
    // @param {string} dir - a directory path to find files in recursively.
    // Get's all files within a directory and it's sub-directories.
    // @returns {Promise} Promise object representing the list of files found in the directory/sub-directories.
    static getFiles(dir, ignores = []) {
        return new Promise(async (resolve, reject) => {
            try {
                let files = await getFiles.find(dir, ignores);
                resolve(files);
            } catch (err) {
                reject(err);
            }
        });
    }
    // @param {Object[]} movies - used to select the path field from the reup_tar_movies table
    // @param {string} type - 'movies' | 'thumbnails' 
    // If type is set to 'movies' it will get paths from the reup_tar_movies table.
    // If type is set to 'thumbnails' it will get paths from the reup_tar_thumbnails table.
    // for each movie file associated with the movie_ids in the movies array.
    // where movie_id in ( moives.map(m => m.movie_id) ), turns into " in (1,2,3,4,5) etc."
    // example: getMoviePaths([{movie_id: 1}, {movie_id: 2}], ['movies'|'thumbnails'])(xxxx)
    // returns a closure function that returns the list of objects 
    // by site_id. 
    // let pathFunc = await getMoviePaths(movieRowsWithMovieIds, 'movies');
    // let moviePaths = pathFunc(xxxx, 'movies');
    // to clear out the cache (not necessary, but it's an option)...
    //   - call await pathFunc(xxxx, 'movies', true); // this just clears out the cache set in PATHS object by site_id.
    // Otherwise if you don't need to clear the cache just get the paths in one call like this and 
    // let the garbage collector worry about clearing out memory:
    // 
    // let moviePaths = await getMoviePaths(movieRowsWithMovieIds, 'movies')(xxxx, 'movies'); 
    // mapped/keyed by {
    //    '/member/movie/1040m.mp4'=> { movie_seq:.., file_number:.., file_size:..,movie_id:..}
    //    '/member/movie/720m.mp4' => { movie_seq:.., file_number:.., file_size:..,movie_id:..}
    //    '/member/movie/240m.mp4' => { movie_seq:.., file_number:.., file_size:..,movie_id:..}
    //  }
    static getMoviePaths(movies, type = 'movies') {

        let PATHS = {};
        let model_name = {
            'movies': {
                'modelName': 'reupTarMovies',
                'attr': ['path', 'movie_seq', 'movie_id', 'file_number',
                    'file_size', 'update_date', 'create_date', 'status',
                    'width', 'height', 'codec', 'bitrate', 'frame_rate',
                    'fake_flag',
                ]
            },
            'thumbnails': {
                'modelName': 'reupTarThumbnails',
                'attr': ['path', 'movie_seq', 'movie_id', 'file_number',
                    'file_size', 'update_date', 'create_date', 'md5', 'status',
                    'width', 'height', 'primary_flag', 'flashimage_flag',
                ]
            },
        };

        let useModel = model_name[type]['modelName'];
        let attributes = model_name[type]['attr'];

        // Closure function.
        // Returns a function that
        // has access to PATHS which 
        // acts as a cache in case it's called multiple times.
        return (site_id, type, clearCache = false) => {
            if (clearCache) {
                //console.log("Clearing out movie paths cache for:", site_id);
                //console.log(`PATHS[${site_id}][${type}] length:`, _.keys(PATHS[site_id][type]).length);
                if (PATHS.hasOwnProperty(site_id) && PATHS[site_id].hasOwnProperty(type)) {
                    PATHS[site_id][type] = null;
                }

                return Promise.resolve();
            }

            return new Promise(async (resolve, reject) => {
                try {
                    if (PATHS.hasOwnProperty(site_id) && PATHS[site_id].hasOwnProperty(type)) {
                        resolve(PATHS[site_id][type]);
                    } else {
                        if (!PATHS.hasOwnProperty(site_id)) {
                            PATHS[site_id] = {};
                            PATHS[site_id][type] = {};
                        }
                    }


                    let movieModel = MediaInfoWorker.models['movies']; // get the movies model
                    let model = MediaInfoWorker.models[useModel];

                    movieModel.hasMany(model, {
                        foreignKey: 'movie_id'
                    });
                    model.belongsTo(movieModel, {
                        foreignKey: 'movie_id'
                    });

                    let criteria = {
                        'attributes': attributes,
                        'where': {
                            'movie_id': {
                                [Op.in]: movies.map((m) => m.movie_id)
                            },
                        },
                        'include': [{
                            model: movieModel,
                            attributes: ['site_id', 'movie_date_id']
                        }],
                    };

                    // Ensure we only get "real" movie paths
                    // not the fake path hack that we create
                    // per movie path.
                    if (type == 'movies') {
                        criteria['where']['fake_flag'] = false;
                    }

                    let data = await model.findAll(criteria);

                    await (() => Promise.all(data.map(paths => {
                        return new Promise(async (res, rej) => {
                            PATHS[site_id][type][paths.path] = {
                                'path': paths.path,
                                // fileFoundOnFS is used to audit the paths later on.
                                // the idea is to set this to true if the file exists
                                // in the file system (FS) for this file path.
                                // Because if the file got deleted on the FS
                                // we want to set the status on the DB to STATUS_FILEDELETED.
                                // So that the meta system app can mark it as deleted file on their systems.
                                'fileFoundOnFS': false,
                            };

                            PATHS[site_id][type][paths.path]['site_id'] = paths['Movie']['site_id'];
                            PATHS[site_id][type][paths.path]['movie_date_id'] = paths['Movie']['movie_date_id'];
                            for (let key of attributes) {
                                PATHS[site_id][type][paths.path][key] = paths[key];
                            }

                            res();
                        });
                    })))();

                    //console.log(`PATHS ${site_id}, ${type}`, JSON.stringify(PATHS, null, 2));
                    // resolve after PATHS are populated with the paths.
                    resolve(PATHS[site_id][type]);
                } catch (err) {
                    reject(err);
                }
            });
        };
    }
    // @param {number} siteID - the site id to associate with the configuriation sitesConfig[siteID]
    // @param {Object} movie - is movie row object from the sequelisejs query results for a specific movie.
    // @param {string} dirType - 'movies', 'sample', 'image'. Found in the sitesConfig[siteID]['dir'][dirType]
    // @returns {Promise} a Promise representing all directories (that exists on the file system) 
    // configured in sitesConfig[sieID]['dir'][dirType].
    static getDirectories(siteID, movie, dirType) {
        return new Promise((resolve, reject) => {
            let dirKeys = Object.keys(sitesConfig[siteID].dir);
            let dirTypes = {};
            dirKeys.map((key) => {
                dirTypes[key] = 1;
            });

            // Validate that dirType exist in the sitesConfig[siteID]['dir'] object.
            if (!dirTypes[dirType]) {
                return reject(`${dirType} does not exists in the 'dir' configuration for this site: ${siteID}`);
            }

            let dirs = sitesConfig[siteID]['dir'][dirType];
            let movieDateID = movie.movie_date_id; //+++++++here needs source_movie_date_id for Mura
            let movieDirectories = [];

            //console.debug("DEBUG: dirs:", dirs);
            let promises = dirs.map((directory) => {
                return new Promise(async (resolve, reject) => {
                    let tmpdir = '/' + directory;
                    tmpdir = path.normalize(tmpdir.replace(MOVIE_REGEX, movieDateID));
                    // check if directory actually exists, first.
                    fs.access(tmpdir, fs.constants.R_OK, (err) => {
                        if (err && err.code === 'ENOENT') {
                            if (WARN_DIR_NOT_EXISTS) logger.info(`directory does not exists:, ${tmpdir}`);
                        } else {
                            movieDirectories.push(tmpdir);
                        }
                        resolve();
                    });

                });
            });

            // Wait for all promises in the actions list to resolve, then resolve with the movieDirectories.
            Promise.all(promises).then(() => {
                if (0 < movieDirectories.length) return resolve(movieDirectories);

                resolve(null);
            });
        });
    }
    // Inserts found movie files into the database table with media info data from ffprobe.
    // @param {number} site_id - the siteID i.e xxxx.
    // @param {Object} movie - the movie object row from the db.
    // @param {Object[]} moviePaths - the objects with 'path' data from the db.
    // @param {string} dirType - the property of the sitesConfig[site_id].dir object to get directories from currently ['movie','sample'] 
    static importFiles(site_id, movie, moviePaths, dirType) {
        return new Promise(async (resolve, reject) => {
            // get directories that exists, configured in the sites config
            // for the specific "movie"
            let directories = await MediaInfoWorker.getDirectories(site_id, movie, dirType);
            if (directories == null) return resolve();

            // Get the files in the directories
            let movieFiles = await MediaInfoWorker.getMovieFiles(site_id, directories, dirType);

            if (_.isEmpty(movieFiles)) return resolve();

            await Promise.all(movieFiles.map(async (file) => {
                return new Promise(async (res, rej) => {
                    // If file is empty there was invalid data returned by ffprobe.
                    // so we skip it. Maybe we should track these files and report on them?
                    // If we do decide that then let's add the logic here.
                    if (_.isEmpty(file)) {
                        return res();
                    }

                    let pathData = undefined;
                    if (moviePaths.hasOwnProperty(file['uri_path']) && moviePaths[file['uri_path']] != "") {
                        // we found the known file on the files system. 
                        moviePaths[file['uri_path']]['fileFoundOnFS'] = true;

                        pathData = moviePaths[file['uri_path']];
                    }

                    let params = {
                        'site_id': site_id,
                        'pathData': pathData,
                        'file': file,
                        'dirType': dirType, // 'image' or 'movies' or 'sample'
                        'movie': movie, // the movie row
                    };

                    try {
                        if (dirType != 'image') {
                            await MediaInfoWorker.insertReupTarMovie(params);
                            res();
                        } else {
                            // dirType is 'image'
                            await MediaInfoWorker.insertReupTarThumbnail(params);
                            res();
                        }
                    } catch (err) {
                        logger.error(`importFiles: ${err}`);
                        res();
                    }
                });
            }));

            return resolve();
        });
    }
    // @param {number} site_id - the site's site id to process.
    // @param {Object} sitesConfig - the configuration for the sites
    // @param {Object} params - the control parameters.
    // This function is used as the main function to process/import
    // found movies/images on the file sytem and import them into the database.
    // It first gets movies to process from the movies table (getMovies(site_id))
    // Then gets all associated movie paths from the reup_tar_movies table (getMoviePaths(movies))
    // Then for each movie in the movies list.
    // it imports sample movies, member movies, and images.
    static ProcessSite(site_id, sitesCONFIG, params = {}) {
        if (_.has(params, 'logger')) {
            // set logger to passed in logger param
            logger = params['logger'];
        }

        if (!_.isObject(sitesCONFIG)) {
            logger.error(`ProcessSite: Needs a sitesConfig configuration`);
            return;
        }

        let processRowsLimit = 50;
        let lastUpdated = 2;
        let movie_id;
        let released = null;

        if (!_.isEmpty(params)) {
            if (_.has(params, 'processRowsCount')) {
                if (_.isFinite(params.processRowsCount)) {
                    processRowsLimit = params.processRowsCount;
                }
                // Ensure we don't set processRowsLimit too low
                if (processRowsLimit < 5) {
                    processRowsLimit = 5;
                }

                // Ensure we don't set processRowsLimit over 500
                if (processRowsLimit >= 500) {
                    processRowsLimit = 500; // our max we want this set too.
                }
            }
            if (_.has(params, 'lastUpdated')) {
                lastUpdated = params.lastUpdated;
            }
            if (_.has(params, 'movie_id')) {
                movie_id = params['movie_id'];
            }
            if (_.has(params, 'approved_released_days_ago')) {
                released = params['approved_released_days_ago'];
            }
        }

        sitesConfig = sitesCONFIG;

        return new Promise(async (resolve, reject) => {

            if (_.has(params, 'maxffprobe') && params['maxffprobe'] > 0) {
                await ffmpeg.setSemaConcurrency(params.maxffprobe);
            }

            let config = sitesConfig[site_id];

            logger.info(`ProcessSite: ${site_id}`);
            if (!config) return;

            let movies = [];
            try {
                let p = {}; // params object for MediaInfoWorker.getMovies() call

                if (released) {
                    logger.info(`Processing 'approved' released movies that were released more than ${released} days ago`);
                    p['approved_released_days_ago'] = released;
                } else {

                    if (lastUpdated == 0) { // means get all rows from the db.
                        logger.info(`Getting all movies for site_id: ${site_id}`);
                    } else {
                        logger.info(`Getting movies lastupdated: ${lastUpdated} hours ago for site_id: ${site_id}`);
                        p['gte_updated_hrs'] = lastUpdated; // greater than or equal to lastUpdated hours.
                    }
                }

                if (movie_id) {
                    p['movie_id'] = movie_id;
                }

                movies = await MediaInfoWorker.getMovies(site_id, p);

                let rowCount = movies.rows.length;
                let start = 0;
                let processedCount = 0;

                // This steps through the movies rows to process.
                // processMovieRows() takes the start and limit.
                // This for loop calls processRows giving the start 0 and
                // the count of rows to process from movies.rows. So if movies.rows has
                // 1,000 rows and we want to wait and only process 100 at a time we
                // call processMovieRows(site, rows, 0, 100).  processMovieRows returns the processedCount
                // which we asign back to the start variable. And call processMovieRows again till there's no
                // more rows to process.  This ensures we wait till a certain amount of movie rows are
                // processed till we do another set till it's done.
                for (start = 0; start < rowCount;) {
                    if (processedCount == 0) {
                        processedCount = await MediaInfoWorker.processMovieRows(site_id, movies.rows, start, processRowsLimit, params);
                        start = processedCount;
                    } else {
                        processedCount = await MediaInfoWorker.processMovieRows(site_id, movies.rows, start, processRowsLimit, params);
                        start = processedCount;
                    }
                }

                resolve();
            } catch (err) {
                logger.error(`ProcessSite: ${err}`);
                reject(err);
            }
        });
    }
    // processMovieRows
    // @param {number} site_id
    // @param {Array} movieRows - movie row objects from the database
    // @param {number} startIndex - the row to start at from movieRows
    // @param {number} limit - step through this many rows starting from startIndex
    // @returns {Promise} a promise with the count of movie rows we processed.
    static processMovieRows(site_id, movieRows, startIndex = 0, limit = 50, params = {}) {
        return new Promise(async (resolve, reject) => {
            let len = movieRows.length;
            let endIndex = startIndex + limit;
            if (endIndex > len) {
                endIndex = len;
            }

            let dirType;
            if (_.has(params, 'dirtype')) {
                dirType = params['dirtype'];
            }

            //logger.info(`rows Length: ${len} startIndx: ${startIndex} endIndex: ${endIndex}`);
            let movies = movieRows.slice(startIndex, endIndex);

            // Setup movie path lists.
            let moviePathsFnc = await MediaInfoWorker.getMoviePaths(movies, 'movies');
            let moviePaths = await moviePathsFnc(site_id, 'movies');

            // Setup thumbnail paths lists
            let thumbPathsFnc = await MediaInfoWorker.getMoviePaths(movies, 'thumbnails');
            let thumbPaths = await thumbPathsFnc(site_id, 'thumbnails');
            let procCount = startIndex;
            await (() => Promise.all(movies.map(async (movie) => {
                let mediaInfoWork = new MediaInfoWorker(site_id, movie, moviePaths, thumbPaths);

                // Now find movies, sample movies and images to import into the DB
                // for this movie.
                if (dirType != undefined) {
                    if (dirType == 'thumbnails' || dirType == 'image') await mediaInfoWork.importImages();
                    if (dirType == 'sample') await mediaInfoWork.importSampleMovies();
                    if (dirType == 'member') await mediaInfoWork.importMemberMovies();
                } else {
                    // process all images/sample/member movies
                    // TODO: test running the following 3 calls using Promise.all([])
                    await mediaInfoWork.importImages();
                    await mediaInfoWork.updateFlashImageFlag();

                    await mediaInfoWork.importSampleMovies();
                    await mediaInfoWork.importMemberMovies();
                }
                procCount++;
            })))();

            // function call to run through all the moviePaths and thumbPaths
            // in order to find files that no longer exists, and set the status to 0
            // in the reup_tar_thumbnails and reup_tar_movies tables.
            await MediaInfoWorker.auditThumbnailsPaths(thumbPaths);
            await MediaInfoWorker.auditMoviesPaths(moviePaths);

            // Figure out later on how we can add missing
            // fakePaths to existing records that don't have an associated
            // fakePath. 
            //await MediaInfoWorker.addMissingFakePaths(movies, moviePaths);

            await moviePathsFnc(site_id, 'movies', true); //clear out movie path cache
            await thumbPathsFnc(site_id, 'thumbnails', true); // clear out thumb path cache

            await MediaInfoWorker.updateReupLegacyMovieSeq(); // see function for details.

            //console.log(`Processed ${procCount} movie rows...`);
            resolve(procCount);
        });
    }
    static insertReupTarThumbnail(params = {}) {
        let site_id = params['site_id'];
        let movie = params['movie'];
        let file = params['file'];
        let pathData = params['pathData'];
        let model_name = 'reupTarThumbnails';

        let doUpdate = false;

        return new Promise(async (resolve, reject) => {

            let primary_flag = await MediaInfoWorker.getFlag(site_id, file.uri_path, movie.movie_date_id, 'image_primary');

            let data = {
                movie_id: movie.movie_id,
                movie_seq: movie.movie_seq,
                server_name: sitesConfig[site_id]['image_server_name'], // froms sites_config
                path: file.uri_path,
                height: file.height,
                width: file.width,
                file_size: file.file_size,
                create_date: file.createDate, // the files creation date
                update_date: file.updateDate, // the files update date
                md5: file.md5,
                primary_flag: primary_flag,
                flashimage_flag: 0,
                imagerotation_flag: 0, // set to 0 for now as it's not needed. NOTE: on legacy it sets to 1 if the path is /ir/MOVIE_ID/animaged.gif...
            };

            //status: (movie.production_status == 'approved') ? 1 : 0,
            data['status'] = await MediaInfoWorker.getStatus(movie);

            // Update movie.movies.has_flash_image
            let priority = await MediaInfoWorker.getFlag(site_id, file.uri_path, movie.movie_date_id, 'flash_image');
            await MediaInfoWorker.updateMovieHasFlashImage(movie, {
                flashimage_flag: (priority > 0) ? true : false
            });


            if (pathData != undefined) {
                for (let f of ['file_size', 'md5', 'status', 'width', 'height', 'primary_flag']) {
                    if (pathData[f] != data[f]) { // something changed
                        //console.log("Field: ", f, ' has changed, old value:', pathData[f]);
                        doUpdate = true;
                        break;
                    }
                }
                // We have data for this uri path and nothing changed so skip insert or update.
                if (!doUpdate) return resolve();
            }

            try {
                if (doUpdate) {
                    logger.info(`Updating image file: (${movie.movie_id}) - uri:${file.uri_path}, filePath: ${file.file_path}`);
                    let thumbnailFile = await MediaInfoWorker.models[model_name].findByPk(pathData['file_number']);
                    //console.log("thumbnailFile:", thumbnailFile);

                    await thumbnailFile.update(data, {
                        'fields': _.keys(data)
                    });
                    MediaInfoWorker.Count.UpdatedThumbnails++;
                } else {
                    logger.info(`Saving new image file: (${movie.movie_id}) - uri:${file.uri_path}, filePath: ${file.file_path}`);
                    // Let's insert this new file and it's info into the reup_tar_movies table.
                    let newThumbnailFile = MediaInfoWorker.models['reupTarThumbnails'].build(data);
                    await newThumbnailFile.save();
                    MediaInfoWorker.Count.NewThumbnails++;
                }

                return resolve();
            } catch (err) {
                logger.error(`insertReupThumbnail: ${err}`);
                return reject(err);
            }
        });
    }
    static insertReupTarMovie(params = {}) {
        let site_id = params['site_id'];
        let movie = params['movie'];
        let file = params['file'];
        let dirType = params['dirType'];
        let pathData = params['pathData'];
        let doUpdate = false;
        let model_name = 'reupTarMovies';

        // Changes the server_name field based on the configuration
        // There's one for sample movies and one for member movies
        // the config property for member movies is 'movie_server_name'
        // the config proprty for sample movies is 'sample_server_name'
        // currently host/server_name for sample is smovie.xxxxxxx for xxxxxxx etc.
        // Ofcourse I would love to not have separate subdomains and just use one.
        // Maybe later we can do that but for now we need a separate domain for sample
        // so it's in the configuration file. config/config_mediainfo_sites.js
        // If later it's decided to just use one. We can just consolidate in the config
        // and do a db update to change it all back when needed.
        let serverNameField = (dirType == 'sample') ? 'sample_server_name' : 'movie_server_name';

        return new Promise(async (resolve, reject) => {

            let status = ((0 > file.bit_rate) || ("" == file.codec_type)) ? 0 :
                await MediaInfoWorker.getStatus(movie);

            // check frame_rate, if > 99.99 set to null
            if (file.frame_rate && file.frame_rate > 99.99) {
                file.frame_rate = null;
            }

            let data = {
                movie_id: movie.movie_id,
                movie_seq: movie.movie_seq,
                server_name: sitesConfig[site_id][serverNameField], // froms sites_config
                path: file.uri_path,
                file_type: file.file_type,
                sample_flag: (dirType == 'movies') ? 0 : 1,
                codec: file.codec_name, // h264 etc...
                height: file.height,
                width: file.width,
                bitrate: file.bit_rate,
                file_size: file.file_size,
                create_date: file.createDate, // the files creation date
                update_date: file.updateDate, // the files update date
                frame_rate: file.frame_rate,
                status: status,
                fake_flag: false,
            };

            // Create Fake Path for member not sample movies.
            let dataFakePath = {};
            let fakePath = null;
            if (dirType == 'movies' && sitesConfig[site_id]['make_fake_filepaths'] == true) {
                let addFakePaths = true; // default to true to add fake paths, will set to false if we have an allowed extensions config and it does not meet that check.
                let allowed = sitesConfig[site_id]['allowedFakePathFileExt'];
                // if we have allowed config for fake path extenstions check it
                if (Array.isArray(allowed) && allowed.length > 0) {
                    let chkExt = path.extname(file.uri_path);
                    if (typeof chkExt == 'string' && chkExt !== '') {
                        chkExt = chkExt.toLowerCase();
                        addFakePaths = false; // will set back to true if file extension matches allowed extensions for fake paths.
                        for (let val of allowed) {
                            if (val === undefined || val === null) continue;

                            val = val.toLowerCase();
                            if (chkExt === val) {
                                addFakePaths = true;
                                break;
                            }
                        }
                    }
                    if (addFakePaths == false) {
                        logger.info(`skip adding fake file path for file: ${file.uri_path}`)
                    }
                }

                if (addFakePaths) {
                    fakePath = await MediaInfoWorker.getFakePath(site_id, file.uri_path, movie.movie_date_id);

                    dataFakePath = {
                        movie_id: movie.movie_id,
                        movie_seq: movie.movie_seq,
                        server_name: sitesConfig[site_id][serverNameField], // froms sites_config
                        path: fakePath,
                        file_type: file.file_type,
                        sample_flag: (dirType == 'movies') ? 0 : 1,
                        codec: file.codec_name, // h264 etc...
                        height: file.height,
                        width: file.width,
                        bitrate: file.bit_rate,
                        file_size: file.file_size,
                        create_date: file.createDate, // the files creation date
                        update_date: file.updateDate, // the files update date
                        frame_rate: file.frame_rate,
                        status: status,
                        fake_flag: true,
                    };
                }
            }

            try {
                // Update movie.movies.duration_seconds
                // duration_seconds is currently not done via the DLAdmin, we
                // will use the duration from media info to set it.
                // It also updates it if there's a change from the db and the file
                if (dirType == 'movies') await MediaInfoWorker.updateMovieDuration(movie, file);

                // If we have pathData for this file, then we've seen it before and
                // it is in the database. So we'll check here if anything has changed
                // that we care about and set doUpdate to let us know to update the row in the DB.
                if (pathData != undefined) {
                    for (let f of ['file_size', 'status', 'width', 'height', 'codec', 'bitrate', 'frame_rate']) {
                        if (pathData[f] != data[f]) { // something changed
                            //console.log("Field: ", f, ' has changed, old value:', pathData[f]);
                            doUpdate = true;
                            break;
                        }
                    }
                    // We have data for this uri path and nothing changed so skip insert or update.
                    if (!doUpdate) return resolve();
                }

                await MediaInfoWorker.models.DB.transaction(async (trx) => {
                    if (doUpdate) {
                        logger.info(`Updating movie file: (MovieID: ${movie.movie_id}) - uri:${file.uri_path}, filePath: ${file.file_path}, FileNumber: ${pathData['file_number']}`);
                        let movieFile = await MediaInfoWorker.models[model_name].findByPk(pathData['file_number'], {
                            transaction: trx
                        });

                        if (movieFile != null) {
                            //console.log("movieFile:", movieFile);
                            await movieFile.update(data, {
                                'fields': _.keys(data),
                                transaction: trx,
                            });
                        }

                        if (fakePath != null) {
                            let fakeMovieFile = await MediaInfoWorker.models[model_name].findOne({
                                where: {
                                    movie_id: dataFakePath.movie_id,
                                    path: dataFakePath.path,
                                    fake_flag: true,
                                },
                                transaction: trx
                            });

                            if (fakeMovieFile != null) {
                                //console.log("movieFile:", movieFile);
                                await fakeMovieFile.update(dataFakePath, {
                                    'fields': _.keys(dataFakePath),
                                    transaction: trx,
                                });
                            } else {
                                // We need to insert this fake movie path.
                                logger.info(`Saving new fake movie file: (${movie.movie_id}) - fake-uri:${dataFakePath.path}, filePath: ${file.file_path}`);
                                let newFakeMovie = MediaInfoWorker.models[model_name].build(dataFakePath);
                                await newFakeMovie.save({
                                    transaction: trx
                                });
                            }
                        }

                        // if dirType is not 'movies' then its assumed to be sample..
                        (dirType == 'movies') ? MediaInfoWorker.Count.UpdatedMovies++: MediaInfoWorker.Count.UpdatedSampleMovies++;

                    } else {
                        // If we get here, we're inserting a new file into the DB...
                        logger.info(`Saving new movie file: (${movie.movie_id}) - uri:${file.uri_path}, filePath: ${file.file_path}`);
                        // Let's insert this new file and it's info into the reup_tar_movies table.
                        let newReupTarMovieFile = MediaInfoWorker.models[model_name].build(data);
                        await newReupTarMovieFile.save({
                            transaction: trx
                        });

                        // if dirType is not 'movies' then its assumed to be sample..
                        (dirType == 'movies') ? MediaInfoWorker.Count.NewMovies++: MediaInfoWorker.Count.NewSampleMovies++;

                        // Now let's add the fake path but only for member movies not sample
                        if (fakePath != null) {
                            logger.info(`Saving new fake movie file: (${movie.movie_id}) - fake-uri:${dataFakePath.path}, filePath: ${file.file_path}`);
                            // Let check if this fakePath already exists before we try to insert it.
                            // Somtimes this happens.
                            let fakeMovieFile = await MediaInfoWorker.models[model_name].findOne({
                                where: {
                                    movie_id: dataFakePath.movie_id,
                                    path: dataFakePath.path,
                                    fake_flag: true,
                                },
                                transaction: trx
                            });

                            if (fakeMovieFile == null) {
                                // Doesn't exist, so create and save it.
                                let newFakeMovie = MediaInfoWorker.models[model_name].build(dataFakePath);
                                await newFakeMovie.save({
                                    transaction: trx
                                });

                            } else {
                                // Already exists so just update with the new data
                                await fakeMovieFile.update(dataFakePath, {
                                    'fields': _.keys(dataFakePath),
                                    transaction: trx,
                                });
                            }
                        }
                    }
                });

                return resolve();
            } catch (err) {
                logger.error(err);
                return reject(err);
            }
        });
    }
    static updateMovieHasFlashImage(movie, fileinfo) {

        if (!UPDATE_HAS_FLASH_IMAGE) return;

        return new Promise(async (resolve, reject) => {
            // if false no need to do anything
            if (fileinfo.flashimage_flag == false) {
                return resolve();
            }

            // movie has_flash_image is already set to true
            // letting us know that it was already set and we found a 
            // an image in one of the configured directories that matches
            if (movie.has_flash_image == true) {
                return resolve();
            }

            movie.has_flash_image = true;
            await movie.save();

            return resolve();
        });
    }
    // updateMovieDuration
    // NOTE: We're only setting the duration for 1080p.mp4 filenames.
    // so in order to ensure we get durations for a movie, the 1080p.mp4 filename
    // should be uploaded by the webmasters.
    // @param {object} - movie, is the movie row object from the DB
    // @param {object} - fileinfo, the file object with the mediainfo data that has the duration of of the movie.
    // @returns {Promise} - a promise 
    static updateMovieDuration(movie, fileinfo) {

        if (!UPDATE_MOVIE_DURATION) return;

        //console.log("DEBUG - updateMovieDuration(): ", fileinfo);
        return new Promise(async (resolve, reject) => {
            try {
                // Skip if fileinfo.duration < 1
                if (fileinfo.duration < 1) {
                    //console.log("DEBUG: skip updating duration_seconds");
                    //console.log("DEBUG: fileinfo.duration:", fileinfo.duration, " movie.duration_seconds:", movie.duration_seconds);
                    //console.log("DEBUG: movie.movie_id:", movie.movie_id);
                    return resolve();
                }

                let fname = path.basename(fileinfo.file_path);

                // Hardcoded filename to use for checking duration.
                // If filename is not 1080p.mp4 we'll skip checking the duration of the movie.
                if (fname != '1080p.mp4') return resolve();

                let fileDurationSeconds = Math.round(fileinfo.duration);
                let movieDurationSeconds;

                if (movie.duration_seconds == undefined || movie.duration_seconds == null) {
                    movieDurationSeconds = 0;
                } else {
                    movieDurationSeconds = movie.duration_seconds;
                }

                //console.log("DEBUG: movieDurationSeconds:", movieDurationSeconds, " file duration:", fileDurationSeconds);

                // return if nothing has changed between movie.duration_seconds and fileinfo.duration
                if (movieDurationSeconds == fileDurationSeconds) {
                    return resolve();
                }

                //console.log("DEBUG: updating movie.duration_seconds to ", fileDurationSeconds);
                movie.duration_seconds = fileDurationSeconds;
                await movie.save();
                return resolve();
            } catch (err) {
                logger.error(`updateMovieDuration Error: ${err}`);
                return reject(err);
            }
        });
    }
    // getStatus(movie)
    // given the movie it will check the release date
    // if the release date is in the future then the STATUS_NOTRLEASED is returned.
    // if the release date is in the past AND the production_status == 'approved' then STATUS_RELEASED is returned.
    // if the expire_date is in the past the movie has expired, then STATUS_NOTRELEASED is returned.
    // @param {Object} movie is an object representing the movie row from the movies table.
    // @returns STATUS_RELEASED or STATUS_NOTRELEASED
    static getStatus(movie) {
        return new Promise(async (resolve, reject) => {

            let current_date = moment().utc();
            let release_date = moment(movie.release_date).utc();

            // Handle expired movies.
            if (movie.expire_date != null) {
                let expire_date = moment(movie.expire_date).utc();
                // Let's check movie's expire_date
                if (expire_date.isBefore(current_date)) {
                    // Setting expired movies back to not released status,
                    // until we decide on another number to represent 'expired' movies.
                    return resolve(STATUS_NOTRELEASED);
                }
            }

            //console.log("DEBUG: release_date.utc():", release_date, " current_date.utc():", current_date);

            // If release date is before the current date and production_status is approved then it's released 
            if (release_date.isBefore(current_date)) {

                // Release date is within 1hour from now, so let's
                // set status to relesased. Weird business logic but I guess we do this so meta
                // can release the files before the movie is released.
                //
                // -- Actually ignore above comment and commenting this out for now.
                // -- Because we don't want to set the file as released
                // -- if for some reason the production_status never gets
                // -- set to 'approved'. Maybe we need another
                // -- production_status like 'pre_approved' meaning
                // -- all checks are good for release but it's wating on release date.
                // -- Until then I don't want to just blindly set the files to released
                // -- 1 hour before the 'release_date'.
                // -- So if we ever get around to a 'pre_approved' production status
                // -- we can add to the if statement commented out below
                // -- to also check if movie.production_status == 'pre_approved' or 'ready_for_release'
                // -- etc. etc.
                // -- READ ABOVE COMMENT for why I commented this out....
                //if (release_date.isAfter(current_date.subtract(1, 'hour'))) {
                //    return resolve(STATUS_RELEASED);
                //}

                // if approved set to released
                if (movie.production_status == 'approved') {
                    return resolve(STATUS_RELEASED);
                } else {
                    // production_status is not 'approved' yet but release date is before current date.
                    // so movie is still not released until production_status is also approved.
                    return resolve(STATUS_NOTRELEASED);
                }
            }

            if (release_date.isAfter(current_date)) {
                return resolve(STATUS_NOTRELEASED);
            }

        });
    }
    static auditThumbnailsPaths(paths) {
        let model_name = 'reupTarThumbnails';
        return MediaInfoWorker.updateDeletedStatus(model_name, paths);
    }
    static auditMoviesPaths(paths) {
        let model_name = 'reupTarMovies';
        return new Promise(async (resolve, reject) => {
            await MediaInfoWorker.updateDeletedStatus(model_name, paths);
            return resolve();
        });
    }
    // Go through all paths and 
    // check if the file does not exists anymore
    // if no longer exists then set status to STATUS_FILEDELETED.
    static updateDeletedStatus(modelName, paths) {
        let model_name = modelName;

        // Lets check the paths and
        // set status to 0 if the fileFoundOnFS == false
        return new Promise(async (resolve, reject) => {
            //console.log("DEBUG - updateDeletedStatus modelName:", model_name);
            for (let fpath of _.keys(paths)) {
                let pathData = paths[fpath];

                // This property is set to true when it is found
                // so we skip if it is.
                if (pathData['fileFoundOnFS'] == true) continue;

                // status is already set so continue 
                if (pathData['status'] == STATUS_FILEDELETED) continue;

                try {
                    await MediaInfoWorker.models.DB.transaction(async trx => {
                        //console.log("DEBUG: - key:", fpath, " value: ", pathData);
                        let fileRow = await MediaInfoWorker.models[model_name].findByPk(pathData['file_number'], {
                            transaction: trx,
                        });

                        await fileRow.update({
                            'status': STATUS_FILEDELETED
                        }, {
                            'fields': ['status'],
                            transaction: trx,
                        });

                        // Here we check the associated "Fake File Paths" for
                        // movies only. And set its status to deleted if found.
                        if (model_name == 'reupTarMovies') {
                            let movie_id = pathData['movie_id'];
                            let site_id = pathData['site_id'];
                            let uri_path = pathData['path'];
                            let movie_date_id = pathData['movie_date_id'];
                            let fakePath = await MediaInfoWorker.getFakePath(site_id, uri_path, movie_date_id)

                            // We have a fake path let's update it
                            if (fakePath != null) {
                                // now set the fake path status to deleted
                                let fakeFileRow = await MediaInfoWorker.models[model_name].findOne({
                                    where: {
                                        movie_id: movie_id,
                                        path: fakePath,
                                        fake_flag: true,
                                    },
                                    transaction: trx,
                                });

                                if (fakeFileRow != null) {
                                    await fakeFileRow.update({
                                        'status': STATUS_FILEDELETED
                                    }, {
                                        'fields': ['status'],
                                        transaction: trx,
                                    });
                                }
                            }
                        }
                    });

                    if (model_name == 'reupTarThumbnails') MediaInfoWorker.Count.StatusDeletedThumbnails++;
                    if (model_name == 'reupTarMovies') MediaInfoWorker.Count.StatusDeletedMovies++;
                } catch (err) {
                    console.log("Error:", err);
                }
            }

            return resolve();
        });
    }
    static getFakePath(site_id, uriPath, movieDateId) {
        return new Promise((resolve, reject) => {
            if (sitesConfig[site_id]['make_fake_filepaths'] == true) {
                let fakeFormat = sitesConfig[site_id]['fake_path_format'];
                let basePath = path.dirname(uriPath);
                let fname = path.basename(uriPath); // get the filename
                let fakePath = util.format(fakeFormat, basePath, movieDateId, fname);
                resolve(fakePath);
            } else {
                resolve(null);
            }
        });
    }
    // Runs raw query to update the movie_seq on
    // the reup_tar_movies and reup_tar_thumbnails tables
    // that have associated legacy movie_ids in the legacy DL DB.
    //  BEGIN;
    //  update reup_tar_thumbnails as m SET movie_seq = l.legacy_movie_seq FROM legacy as l WHERE m.movie_id = l.movie_id and (m.movie_seq is null or m.movie_seq = 0);
    //  update reup_tar_movies as m SET movie_seq = l.legacy_movie_seq FROM legacy as l WHERE m.movie_id = l.movie_id and (m.movie_seq is null or m.movie_seq = 0);
    //  COMMIT;
    static updateReupLegacyMovieSeq() {
        return new Promise(async (resolve, reject) => {
            MediaInfoWorker.InitDB(); // just in case we're called without first connecting. This caches the connections so it's ok to call multiple tiimes.
            let updateTarMovieSql = `UPDATE movie.reup_tar_movies as m
                                   SET movie_seq = l.legacy_movie_seq
                                 FROM  movie.legacy as l
                                 WHERE m.movie_id = l.movie_id AND (m.movie_seq is null or m.movie_seq = 0)`;

            let updateTarThumbSql = `UPDATE movie.reup_tar_thumbnails as m
                                    SET movie_seq = l.legacy_movie_seq
                                 FROM  movie.legacy as l
                                 WHERE m.movie_id = l.movie_id AND (m.movie_seq is null or m.movie_seq = 0)`;
            try {
                await MediaInfoWorker.models.DB.transaction(async trx => {
                    await MediaInfoWorker.models.DB.query(updateTarMovieSql, {
                        transaction: trx,
                    });

                    await MediaInfoWorker.models.DB.query(updateTarThumbSql, {
                        transaction: trx,
                    });
                });
            } catch (err) {
                logger.error(`updateReupLegacyMovieSeq: ${err}`);
            }

            return resolve();
        });
    }
}

// Expose sitesConfig in SitesConfig
// modelNames:
// these are the models the modelHelper.GetDbModels
// will use to populate MediaInfoWorker.models with in the GetModels static function.
// Add other models into this list if needed in this worker.
// The models are sequelizejs models that are setup in ../models/modelname.js
MediaInfoWorker['modelNames'] = [
    'movies',
    'movieFiles',
    'movieThumbnails',
    'reupTarMovies',
    'reupTarThumbnails'
];

// Connect to the DB etc.
MediaInfoWorker.InitDB();
MediaInfoWorker.SitesConfig = sitesConfig;
MediaInfoWorker.MOVIE_REGEX = MOVIE_REGEX;

// Global counting
MediaInfoWorker.Count = {
    'NewMovies': 0,
    'NewSampleMovies': 0,
    'NewThumbnails': 0,
    'UpdatedMovies': 0,
    'UpdatedSampleMovies': 0,
    'UpdatedThumbnails': 0,
    'StatusDeletedMovies': 0, // includes both member/sample movies
    'StatusDeletedThumbnails': 0,
}

module.exports = MediaInfoWorker;