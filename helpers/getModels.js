'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const sequelize = require('sequelize');

// DB Config
const conf = require('../config/dbconfig');

// Checks if the modelName.js file exists in ../models/modelName.js 
function modelFileExists(modelName) {
    return new Promise((resolve, reject) => {
        let modelPath = path.resolve(__dirname + '/../models');
        let filePath = modelPath + `/${modelName}.js`;

        fs.access(filePath, fs.constants.R_OK, function (err) {
            if (err) {
                reject(`error model doesn't exists: ${filePath}: ${err.message}`);
            } else {
                resolve(true);
            }
        });
    });
}

let modelCache = {};
let dbCache = {};

module.exports.GetDbModels = function (modelNames = [], env = null, dbOptions = {}) {
    return new Promise(async (resolve, reject) => {

        // Check if all model names have a modelname.js file
        // in the models/ directory.
        await (() => Promise.all(modelNames.map((name) => {
            return new Promise(async (resolve, reject) => {
                try {
                    await modelFileExists(name);
                    resolve();
                } catch (err) {
                    return reject(err);
                }
            });
        })))();

        let nodeEnv, dbconf, dbkey;

        if (_.isEmpty(dbOptions)) {
            nodeEnv = env || process.env.NODE_ENV || 'development';
            dbconf = conf.GetConf(nodeEnv);
        } else {
            dbconf = await conf.GetConfOptions(dbOptions);
        }

        dbkey = dbconf.database + ':' + dbconf.username;

        let sequelizeDb;

        if (dbCache[dbkey] != undefined) {
            sequelizeDb = dbCache[dbkey];
        } else {
            sequelizeDb = new sequelize(dbconf.database, dbconf.username, dbconf.password, dbconf);
            try {
                await sequelizeDb.authenticate();
            } catch (err) {
                console.error("Unable to connect to the database:", err);
            }

            dbCache[dbkey] = sequelizeDb;
        }

        let models = {};
        await (() => Promise.all(modelNames.map((name) => {
            return new Promise((resolve, reject) => {
                if (modelCache[name] != undefined) {
                    models[name] = modelCache[name];
                    resolve();
                } else {
                    let model;
                    model = require(`../models/${name}`);
                    models[name] = model.define(sequelizeDb, sequelize);
                    modelCache[name] = models[name];
                    resolve();
                }
            });
        })))();

        models.DB = sequelizeDb;
        resolve(models);
    });
}