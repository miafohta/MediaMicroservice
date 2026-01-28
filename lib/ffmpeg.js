// ----------------------------------
// Original Author: Shaun B. Jackson <shaun.jackson@hypermediasystems.com>
// Date: 02/15/2019
// ----------------------------------
'use strict';

const os = require('os');
const _ = require('lodash');
const moment = require('moment');
const async = require('async');
const fs = require('fs');
const ffprobe = require('../lib/ffprobe'),
    ffprobeStatic = require('ffprobe-static');
const {
    Sema
} = require('async-sema');
const EventEmitter = require('events');
const myEmitter = new EventEmitter();
const cpus = os.cpus().length;
let concurrency = cpus;

// defaults to number of cpus.
// to override this, call FFMPeg.setSemaConcurrency(number_of_allowable_concurrent_async_calls);
let s = new Sema(
    concurrency, // Allow one call per cpu for ffprobe
    {
        capacity: 100, // Prealloc space for 100 tokens
    },
);

// Using ffprobe, gets the media info for codec_type "video" by default
// If you want the mediainfo data for 'audio', specify it in the
// options object { codec_type: 'audio'}..
// If no options are passed in it will default the codec_type to search to 'video'
async function GetMediaInfo(filePath, options = {}, callback) {

    await s.acquire();

    let data = {};
    data.codec_name = null; // h264, ...
    data.frame_rate = null;
    data.codec_type = null; // video, audio ...
    data.width = null;
    data.height = null;
    data.avg_frame_rate = null;
    data.r_frame_rate = null;
    data.file_path = null;
    data.bit_rate = null;
    data.mtime = null;
    data.file_size = null;
    data.create_time = null;

    // Default options.codec_type to "video"
    if (!options['codec_type']) options['codec_type'] = 'video';

    ffprobe(filePath, {
        path: ffprobeStatic.path
    }, async (err, info) => {
        if (err) {
            s.release(); // release semaphore lock
            callback(err, null);
            return;
        }

        if (_.has(info, 'streams') && _.isArray(info['streams'])) {
            for (let minfo of info.streams) {

                // see options['codec_type'] above.
                // this skips objects in the streams array that don't
                // match the codec_type we are looking for, such as audio.
                // I've noticed video codec type is also used for media
                // such as png files, so don't assume if you're looking for 
                // codec_type for a png file it will be png, test manually first. :-)
                if (minfo.codec_type != options['codec_type']) continue;

                data.codec_name = minfo.codec_name;
                data.codec_type = minfo.codec_type;
                data.width = minfo.width;
                data.height = minfo.height;
                data.avg_frame_rate = minfo.avg_frame_rate
                data.r_frame_rate = minfo.r_frame_rate
                data.bit_rate = minfo.bit_rate; // this bit rate is not the same as the format bit_rate set below..

                // calculate frame_rate based on avg_frame_rate
                if (minfo.avg_frame_rate != '0/0') {
                    let frame_rate = data.avg_frame_rate;
                    let n = frame_rate.split("/");
                    data.frame_rate = (n[0] / n[1]).toFixed(2);
                } else if (minfo.r_frame_rate != '0/0') {
                    let frame_rate = data.r_frame_rate;
                    let n = frame_rate.split("/");
                    data.frame_rate = (n[0] / n[1]).toFixed(2);
                } else {
                    console.error(`Can't get frame_rate for file: ${filePath}`);
                }

                data.file_path = filePath;
            }

        }

        if (_.has(info, 'format')) {
            // use the final bitrate reported by 'format'.'bit_rate' and round it.
            data['bit_rate'] = Math.floor(info['format']['bit_rate'] / 1000) * 1000;
            data['duration'] = info['format']['duration'];
        }

        info = null;

        // get mtime from stats
        try {
            let stats = await statFile(filePath);
            data.mtime = (stats.mtimeMs / 1000); // stats.mtimeMs is in milliseconds so we convert it to seconds.
            data.create_time = (stats.birthtimeMs / 1000); // file's create time
            data.file_size = stats.size;

            let updateDate = moment(stats.mtimeMs).format("YYYY-MM-DD HH:mm:ss");
            let createDate = moment(stats.birthtimeMs).format("YYYY-MM-DD HH:mm:ss");
            data.createDate = createDate;
            data.updateDate = updateDate;

            s.release(); // release semaphore lock
            callback(null, data);
        } catch (err) {
            s.release(); // release semaphore lock
            // We should not get an error since the file was readable 
            // and if we got here the media data happened. But in 
            // case we stat the file and there was an error, handle it just in case.
            callback(err, null);
        }
    });
}

function statFile(filePath) {
    return new Promise((resolve, reject) => {
        fs.stat(filePath, (err, stats) => {
            if (err) {
                reject(err);
            } else {
                resolve(stats);
            }
        });
    });
}

// checks to see if the file in the filePath is readable.
// if not returns error.
function isReadable(filePath) {
    return new Promise((resolve, reject) => {
        fs.access(filePath, fs.constants.R_OK, function (err) {
            if (err) {
                reject(`error: ${filePath}: ${err.message}`);
            } else {
                resolve(true);
            }
        });
    });
}

/*
There are several ways to get the media info for a file. See following Usage for 
examples.

Usage:

const FFMpeg = require('lib/ffmpeg');

let file = '/Users/xxxxxxx/nodejs/tmp/mediainfo/240p.mp4';

FFMpeg.ProcessFile(file, (data)=>{
  // process media info in data
});

// OR using promises

// Simplest way to get mediaInfo for a file.
FFMpeg.ffprobe(file)
  .then((data)=>{
    // MediaInfo in data will look like this:
    // data = { codec_name: 'h264',
    //   frame_rate: '59.94',
    //   codec_type: 'video',
    //   width: 426,
    //   height: 240,
    //   avg_frame_rate: '60000/1001',
    //   file_path: '/Users/xxxxxxx/nodejs/tmp/mediainfo/240p.mp4',
    //   bit_rate: '299972' 
    //  }
  }).catch(err=>{
    // handle error
  });

// OR async await using ffprobe from your async function.

async () => {
    try {
        let mediaInfo = await FFMPeg.ffprobe(file);
        // process mediaInfo.
    } catch (err) {
        // Handle error
    }
}

// Advanced usage, (not really...).
// OR if your adventurous, use events, call FFMpeg.on('ffprobe-data', handlerFunction).
// Listens for 'ffprobe-data' events which passes the data
// to your handlerFunction(data)
// example:
FFMpeg.on('ffprobe-data', (mediaInfo)=>{
    console.log("MediaInfo:", mediaInfo")
});

// now call FFMpeg.ffprobe(path) and an event
// with the data will be emitted 
// for your handler to process
let paths = ['path1', 'path2'];
for (let p of paths) {
    FFMpeg.ffprobe(p);
}

// NOTE: use the method that best fits your needs.
*/

// if the ffprobe-data event handler was setup, set to true to emit events, when media data is found. 
let isListening = false;
class FFMpeg {
    static on(name, callback) {
        switch (name) {
            case 'ffprobe-data':
                //console.log("Setting up ffprobe-data event listener");
                isListening = true;
                myEmitter.on(name, callback);
                break;
            case 'error':
                if (callback) {
                    //console.log("Setting up error event listener");
                    myEmitter.on('error', callback);
                } else {
                    //console.log("Setting up default error event listener");
                    myEmitter.on('error', function (err) {
                        console.error(err);
                    });
                }

                break;
            default:
                console.error("Unknown event:", name);
        }
    }
    static removeListener(name) {
        myEmitter.removeListener(name);
    }
    static async isFileReadable(path) {
        try {
            let f = await isReadable(path);
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }
    static ffprobe(filePath) {
        return new Promise((resolve, reject) => {
            FFMpeg.ProcessFile(filePath, function (err, data) {
                if (err) {
                    reject(err);
                    return;
                }

                // If a listener handler was setup, emit event with data
                if (isListening) myEmitter.emit('ffprobe-data', data);

                resolve(data);
            });
        });
    }
    // Used to take a list of file paths in the files array.
    // Calls the callback() function with the media data for
    // further processing of this data.
    // XXX: TODO - dont use this function yet. It won't work on a list,
    // still work to be done. Need to fix it so it can process multiple files a time.
    // ...
    static ProcessFiles(files, fncCallback) {
        if (!_.isFunction(fncCallback)) {
            console.error("Invalid parameter: fncCallback is not a function..");
            throw new Error("fncCallback is not a function");
        }

        for (let path of files) {
            FFMpeg.ProcessFile(path, fncCallback);
        }
    }
    // Used to get media info for one file path. Calls the callback()
    // function with the media data for further processing of the media data.
    // Use the 'ProcessFiles()' to pass in a list of files. This method
    // is the singular form of it.
    static ProcessFile(filePath, fncCallback) {
        if (!_.isFunction(fncCallback)) {
            console.error("Invalid parameter: fncCallback is not a function..");
            throw new Error("fncCallback is not a function");
        }
        async.waterfall([
            (cb) => {
                if (!FFMpeg.isFileReadable(filePath)) {
                    cb(new Error(`${filePath} is not readable`));
                }
                cb(null, filePath);
            },
            (fpath, cb) => {
                GetMediaInfo(fpath, {}, function (err, info) {
                    if (err) {
                        cb(err, null)
                    } else {
                        cb(null, info);
                    }
                });
            },
        ], (err, results) => {
            if (err) {
                fncCallback(err, null);
                return;
            }

            fncCallback(err, results);
        });
    }
    // Allow us to set number of concurrent async calls to ffprobe
    // if we don't want the default that uses the number of cpus on the system.
    static setSemaConcurrency(conc, cap = 100) {
        // s is global to this file and is set somewhere up above.
        return new Promise((resolve, reject) => {
            if (_.isNumber(conc)) {
                let sema = new Sema(
                    conc, // Allow one call per cpu for ffprobe
                    {
                        capacity: cap, // Prealloc space for 100 tokens
                    },
                );
                s = sema;
                resolve();
            } else {
                console.error("Concurrency value is not a number:", conc, " will use default value of:", cpus);
                resolve();
            }
        });
    };
}


module.exports = FFMpeg;
