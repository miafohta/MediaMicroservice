'use strict';

const {
    Op
} = require("sequelize");

const _ = require('lodash');
const moment = require('moment');
const modelHelper = require('../helpers/getModels');
const path = require('path');
const util = require('util');
const fs = require('fs');
let logger = require('../lib/logger').NewLogger({
    label: 'MediaLinkerWorker'
});

let sitesConfig = {};

// @class MediaLinkerWorker
class MediaLinkerWorker {
    constructor( link_site_id, config, p ) { 
        this.siteConfig = config
        this.linkSiteId = link_site_id  //site id for destination_movie_date_id which will be symlinked to.
        this.params = p
    }    

    static getMovies(mid, options = {}) {
        let cr = {
           movie_id: mid,
        };

        let findOptions = {
            attributes: ['site_id','movie_id', 'movie_date_id'],
            where: cr,
            order: [
                ['movie_id', 'DESC']
            ]
        };

        return new Promise(async (resolve, reject) => {
           try {
               await MediaLinkerWorker.InitDB();

               let data = await MediaLinkerWorker.models['movies'].findAndCountAll(findOptions);
               resolve(data);

            } catch (err) {
               reject(err);
            }
        });
    }

    // Get data from movie_mapping by site ID.
    // @param {number} - site id   
    // @param {string} - source movie date id, destination movie date id
    static getMovieMappings(siteid, options = {}) {
        let cr = {
            destination_site_id: siteid,
        };

        if (options['gte_updated_hrs'] && options['gte_updated_hrs'] > 0) {
            let updated_hrs = options['gte_updated_hrs'];

            // (updated >= time OR release_date >= now()-2hrs)
            cr[Op.or] = [{
                    'updated': {
                        [Op.gte]: moment().subtract(updated_hrs, 'hours').toDate()
                    }
                }
            ];
        } 

        //when these option exists, it queires specific movie data 
        //and not site's data.
        if (options['source_movie_date_id'] && options['destination_movie_date_id']) { 
             cr = {
                 source_site_id:options['source_site_id'],
                 source_movie_date_id:options['source_movie_date_id'],
                 destination_site_id:options['destination_site_id'],
                 destination_movie_date_id: options['destination_movie_date_id']
             }
        }

        let findOptions = {
            attributes: ['source_site_id','source_movie_date_id', 'updated', 'destination_site_id', 'destination_movie_date_id'],
            where: cr, 
            order: [
                ['destination_movie_date_id', 'DESC']
            ] 
        };

        if (options['limit'] > 0) findOptions['limit'] = options['limit'];
        if (options['offset'] > 0) findOptions['offset'] = options['offset'];

        return new Promise(async (resolve, reject) => {
            try {
                await MediaLinkerWorker.InitDB(); // Sets up and caches models

                let data = await MediaLinkerWorker.models['movieMappings'].findAndCountAll(findOptions);
                resolve(data);

            } catch (err) {
                reject(err);
            }
        });
    }

    static InitDB() {
        return new Promise(async (resolve, rej) => {
            try {
                // console.log("Init() - getting models")
                // models are actually cached so if InitDB() is called multiple
                // times it will return the cached models if it wasn't already intialized.
                MediaLinkerWorker.models = await MediaLinkerWorker.GetModels({
                    'env': process.env['NODE_ENV'] || 'development'
                });

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
                logger.info("GetModels func");
                let models = await modelHelper.GetDbModels(MediaLinkerWorker['modelNames'], nodeEnv, dbOptions);
                MediaLinkerWorker.models = models;
                resolve(models);
            } catch (err) {
                reject(err);
            }
        });
    }

    // @param {number} sourcePath - the path for the source movie.
    // @returns {Promise} a Promise for true or false if the path exists on the file system.
    // if source path doesn't exists, program logs error and return false.
    static checkSourcePaths ( sourcePath ) {
            return new Promise( async (resolve, reject) => {
                await fs.access(sourcePath, fs.constants.F_OK, (err) => {
                    if ( err ) {
                        if ( err.code === 'ENOENT' ) {
                            logger.error(`checkSourcePaths: ${sourcePath} does not exist`);
                            return resolve(false);
                        } else {
                            logger.error(`checkSourcePaths: ${sourcePath} read error`);
                            return resolve(false);
                        }
                     } return resolve(true);
                });
            });
    }

    // @param {string} destinationPath - the path for is a linked movie.
    // @returns {Promise} a Promise of true or false if the path  already exists on the file system.
    // if link path already exists, program logs info and return false. This can happen
    // when medialinker checks the same movies already symlinked.
    static checkLinkPaths ( destinationPath ) {
            return new Promise( async (resolve, reject) => {
                await fs.access(destinationPath, fs.constants.F_OK, (err) => {
                    if ( err ) {
                        return resolve(false);
                     } else {
                        logger.info(`checkLinkPaths: ${destinationPath} already exists`);
                        return resolve(true);
                     }
                });
            });
    }

    // @param {string} target - the path for a sourced movie.
    // @param {string} toPath - the path for a linked movie.
    // @returns {Promise} a Promise when finish either fail or success.
    // if failed to create symlinks for some reason, program logs error.
    static createSymlinks ( target, toPath ) {
          return new Promise( async (resolve, reject) => {
              await fs.symlink( target, toPath, (err) => {
                  if (err) {
                      logger.error(`createSymlinks failed: ${err}, ${target} >> ${toPath}`);
                  } else {
                      logger.info(`Symlink created : ${target} >> ${toPath}` );
                      //console.log("Symlink is a directory:", fs.statSync(toPath).isDirectory());
                  }
              });
              resolve();
          });
    }

    // @param {string} target - the path for a sourced movie.
    // @param {string} toPath - the path for a linked movie.
    // @param {string] destBasePath - destination image directory. 
    // @returns {Promise} a Promise when finish either fail or success.
    // if failed to copy images  for some reason, program logs error.
    static copyImages ( target, toPath, destBasePath ) {
          return new Promise( async (resolve, reject) => {
              await fs.mkdir( destBasePath, { recursive: true }, (err) => {
                  if (err) {
                      logger.error(`copyFile create destBasePath failed: ${err}, ${destBasePath}`);
                      return resolve();
                  }
              });

              await fs.copyFile( target, toPath, fs.constants.COPYFILE_EXCL, (err) => {
                  if (err) {
                      logger.error(`copyFile failed: ${err}, ${target} >> ${toPath}`);
                  } else {
                      logger.info(`copyFile  created : ${target} >> ${toPath}` );
                      //console.log("Symlink is a directory:", fs.statSync(toPath).isDirectory());
                  }
              });
              resolve();
          });
    }
    // Main function for this class. 
    // Process movies by site id or movie ids
    // @params No parmas but use constructor vaiables 
    // @returns {Promise} a Promise when finish either fail or success.
    ProcessSite() {
        if (_.has(this.linkSiteId, 'logger')) {
            logger = params['logger'];
        }
        if (!_.isObject(this.siteConfig)) {
            logger.error(`ProcessSite: Needs a sitesConfig configuration`);
            return;
        }

        let processRowsLimit = 50;
        let lastUpdated = 2;
        let smid = 0;
        let dmid = 0;

        if (!_.isEmpty(this.params)) {
            if (_.has(this.params, 'processRowsCount')) {
                if (_.isFinite(this.params.processRowsCount)) {
                    processRowsLimit = this.params.processRowsCount;
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
            if (_.has(this.params, 'lastUpdated')) {
                lastUpdated = this.params.lastUpdated;
            }

            if (_.has(this.params, 'smid')) {
                smid = this.params.smid;
            }

            if (_.has(this.params, 'dmid')) {
                dmid = this.params.dmid;
            }
        }

        return new Promise(async (resolve, reject) => {

            logger.info(`ProcessSite: ${this.linkSiteId}`);
            if (!this.siteConfig) return;

            let movies = [];
            try {
                let pr = {}; 

                if (lastUpdated == 0) { // means get all rows from the db.
                    logger.info(`Getting all movies for site_id: ${this.linkSiteId}`);
                } else {
                    logger.info(`Getting movies lastupdated: ${lastUpdated} hours ago for site_id: ${this.linkSiteId}`);
                    pr['gte_updated_hrs'] = lastUpdated; // greater than or equal to lastUpdated hours.
                }

                //when these params are more than 0, medialinker queries specific movie data by movie id.
                if ( smid > 0 && dmid > 0 ) {
                    logger.info(`Getting source movie id: ${smid}`);
                    let source_movie = await MediaLinkerWorker.getMovies(smid);
                    if( source_movie  < 0 ) {
                        logger.error(`source_movie_id doesn't exist in movies table $(smid)`);
                        resolve();
                    }

                    for( const sm of source_movie.rows) {
                        pr['source_movie_date_id'] =  sm.movie_date_id;
                        pr['source_site_id'] = sm.site_id;
                    }

                    let destination_movie = await MediaLinkerWorker.getMovies(dmid);
                    logger.info(`Getting destination movie id: ${dmid}`);
                    if( destination_movie < 0 ) {
                        logger.error(`dest_movie_id doesn't doesn't exist in movies table $(dmid)`)
                        resolve();
                    }

                    for( const dm of destination_movie.rows) {
                        pr['destination_movie_date_id'] = dm.movie_date_id;                 
                        pr['destination_site_id'] = dm.site_id;                   
                    }
                }

                let mappedMovies = await MediaLinkerWorker.getMovieMappings(this.linkSiteId, pr);
                MediaLinkerWorker.models.DB.close();

                let rowCount = mappedMovies.rows.length;

                if( rowCount < 1 ) {
                    logger.info(`No rows to process in movie_mappings table for site: ${this.linkSiteId}`);
                    resolve();
                }

                logger.info(`RowCount:${rowCount}`);
 
                for( const movie of mappedMovies.rows) {
 
                    let src_sid = movie.source_site_id;
                    let src_mid = movie.source_movie_date_id;
                    let dst_sid = movie.destination_site_id;
                    let dst_mid = movie.destination_movie_date_id;

                    let dir_arr = ['member_dir', 'sample_dir']; 
                    for( const dir of dir_arr ) {
                        let sourcePath = this.siteConfig[src_sid][dir]  + src_mid;
                        let linkPath = this.siteConfig[dst_sid][dir]  + dst_mid;

                        //check source path, if it doesn't exists continue to the next.
                        let source_exists =  await MediaLinkerWorker.checkSourcePaths(sourcePath);
                        if( !source_exists ) {
                             continue;
                        }

                        //check destination path, if exists continue to the next.
                        let dest_exists = await MediaLinkerWorker.checkLinkPaths(linkPath);
                        if( dest_exists ) { 
                            continue;
                        }

                        //Both paths are ok, let's create symlink.
                        await MediaLinkerWorker.createSymlinks( sourcePath, linkPath );

                     }

                     //copy image process 
                     let file_arr = ['list', 'player', 'thumbnail'];
                     for( let file of file_arr) {  
                        let sourceIPath = this.siteConfig[src_sid]['image_path'];
                        let sourceImagePath = sourceIPath.replace('@MOVIE_ID@', src_mid );
                        let destIPath = this.siteConfig[dst_sid]['image_path'];
                        let destImagePath = destIPath.replace('@MOVIE_ID@', dst_mid );

                        let sourceImage = sourceImagePath + this.siteConfig[src_sid]['files'][file];
                        let destImage = destImagePath + this.siteConfig[dst_sid]['files'][file];

                        //check source path, if it doesn't exists continue to the next. ( output error )
                        let source_image_exists = await MediaLinkerWorker.checkSourcePaths(sourceImage);
                        if( !source_image_exists ) {
                            continue;
                        }

                        //check destination path, if exists continue to the next. ( output info only )
                        let dest_image_exists = await MediaLinkerWorker.checkLinkPaths(destImage);
                        if( dest_image_exists ) {
                            continue;
                        }

                        //Both path are ok, lets copy images.
                        await MediaLinkerWorker.copyImages( sourceImage, destImage, destImagePath );

                    }
                }   
                resolve();
            } catch (err) {
                logger.error(`ProcessSite: ${err}`);
                reject(err);
            }
        });
    }
}    
    
MediaLinkerWorker['modelNames'] = [
    'movies',
    'movieMappings',
];
    
module.exports = MediaLinkerWorker;

