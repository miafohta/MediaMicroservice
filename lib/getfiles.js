const readdir = require('../lib/recursive-readdir');
const path = require('path');
const moment = require('moment');
const fs = require('fs');
const md5File = require('md5-file/promise');

// Extension name of files to find in the directory.
// This list was copied from the legacy PHP script and
// was used to find files with these specific file extensions.
const MIMELIST = {
    'avi': 'download',
    'asf': 'download',
    'mpeg': 'download',
    'mpg': 'download',
    'mov': 'download',
    'ram': 'download',
    'rm': 'download',
    'wmv': 'download',
    'zip': 'zip',
    'flv': 'streaming',
    'mp4': 'streaming/ipod',
    'bmp': 'image',
    'gif': 'image',
    'jpeg': 'image',
    'jpg': 'image',
    'png': 'image'
};

class GetFiles {
    // @params
    // @dir = the path to get files from
    // @ignores = list of files to ignore. i.e ["*.html", "test.jpg", "*.ext"]
    // ignores can also have a "function" in it.
    // ignoreFunc = (file, stats)=>{ return stats.isDirectory() && path.basename(file) == "test" }
    // ignores = [ignoreFunc, "*.ext"] ...
    // @use_mime boolean default is true. finds files with ext name in the MIMELIST constant. 
    static find(dir, ignores = [], use_mime = true) {
        return new Promise(async (resolve, reject) => {
            try {
                let files = await readdir(dir, ignores);
                if (use_mime) {
                    let filterFiles = [];
                    for (let i = 0; i < files.length; i++) {
                        let ext = path.extname(files[i]);
                        if (ext != '') ext = ext.replace('.', '');

                        let filetype = MIMELIST[ext];
                        if (filetype == undefined) continue;
                        filterFiles.push(files[i]);
                    }
                    return resolve(filterFiles);
                } else {
                    return resolve(files);
                }
            } catch (err) {
                reject(err);
            }
        });
    }
    static fileType(file) {
        return new Promise((resolve, reject) => {
            let ext = path.extname(file);
            if (ext != '') ext = ext.replace('.', '');

            let filetype = MIMELIST[ext];
            resolve(filetype);
        });
    }
    // simply get's info from the file stat
    static fileInfo(file) {
        return new Promise((resolve, reject) => {
            let fileInfo = {
                fileSize: null, // file size 
                createDate: null, // a readable create date string converted from fs.Stats
                updateDate: null, // a readable udpate date string converted from fs.Stats
                fileStats: null, // this is the fs.stats.Stats object
            };
            fs.stat(file, (err, stats) => {
                if (err) {
                    return reject(err);
                }

                fileInfo.fileSize = stats.size;
                fileInfo.createDate = moment(stats.birthtimeMs).format("YYYY-MM-DD HH:mm:ss");
                fileInfo.updateDate = moment(stats.mtimeMs).format("YYYY-MM-DD HH:mm:ss");
                fileInfo.fileStats = stats;
                resolve(fileInfo);
            });
        });
    }
    // @param {string} file - file path to get the md5 has of.
    // @returns Promise representing the md5 has of a file.
    static md5(file) {
        return md5File(file);
    }
}

// expose MIMELIST to callers as GetFiles.MIMELIST
GetFiles.MIMELIST = MIMELIST;

module.exports = GetFiles;