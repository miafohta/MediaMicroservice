# MediaImport

## Description

This app mainly is used to import data for meta. It uses ffmpeg to get meta data about the movie/image data for each movie as well as determine the relative paths and inserts them into the following tables on the database:

Table: movie.reup_tar_movies
Table: movie.reup_tar_thumbnails
Table: move.movies (Updates the duration_seconds column)

Also, since it is already gathering media info using ffprobe we also update the movie.movies table with movie duration when if finds the 1080p.mp4 file for that movie.

For movies it gets data such as codec/height/bitrate/file-size etc using the ffprobe.

Note, this app is executed by cronjob using the bash script files copied from the scripts/ folder, and setup to run by cronjob on xxxxxxx using the "mediaimport" user.

## Setup

### On xxxxxxx (Production)

1. Add git credentials. Create .netrc file in /home/mediaimport/ dir. Add gitlab credentials for the dl_deploy user.
2. Create Directories
	1. /home/mediaimport/mediainfo-app-prod 
	2. /home/mediaimport/logs
3.  Use pm2 setup/deploy the application 
	1. pm2 deploy pm2conf/pm2-mediainfo-media001.config.js production setup
	2. pm2 deploy pm2conf/pm2-mediainfo-media001.config.js production

NOTE: Once pm2 setup is done. You'll only need to deploy using step 2 if you want to deploy your changes.

### On xxxxxxx (Development)

1. Add git credentials. Create .netrc file in /home/mediaimport/ dir. Add gitlab credentials for the dl_deploy user.
2. Create Directories
	1. /home/mediaimport/mediainfo-app-dev 
	2. /home/mediaimport/logs-dev
3.  Use pm2 setup/deploy the application 
	1. pm2 deploy pm2conf/pm2-mediainfo-media001.config.js development setup
	2. pm2 deploy pm2conf/pm2-mediainfo-media001.config.js development

## Configuration

Configuration is a bit complicated but basically the application uses the config to know what files to search for and in what directories to find member/sample movies and images/thumbnails.  See the configuration in the **mediainfo/config/[SITE_ID]/siteConf.js** file for more info. 

Also look in workers/mediainfo.js file for some documentation of the functionality of what this does based on the configs.

## DB User
Uses the "meta_merc_import" db user to connect and interact with the PostgreSQL DB.

## Cron

See the scripts/run_mediainfo.sh and and scripts/run_mediainfo_all_movies.sh to see how we run the app to on movies that were last updated in past 2 hours or all movies. 

On xxxxxxx we copy these bash scripts to ~/bin/. and set the cronjob as follows:

    # Run mediaImport for production
    */5 * * * * /home/mediaimport/bin/run_mediainfo.sh 2>&1 | tee -a /home/mediaimport/logs/mediaInfo.$(date +"\%Y-\%m-\%d").log
    
      
    
    # Run mediaImport on ALL files once a day at 10am
    
    0 10 * * * /home/mediaimport/bin/run_mediainfo_all_movies.sh 2>&1 | tee -a /home/mediaimport/logs/mediaInfo.ALLMOVIES.$(date +"\%Y-\%m-\%d").log
