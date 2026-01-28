#!/bin/bash

#Application Dir
appDir='/home/mediaimport/mediainfo-app/current';

# Directory path to the site configuration files
configDirPath="$appDir/mediainfo/config"

export PATH=/home/mediaimport/bin:$PATH;

#for nodeENV in production staging
for nodeENV in production
do
  export NODE_ENV=$nodeENV;

  for siteID in xxxx xxxx xxxx xxxx
  do
    # Process all movies last updated more than 2 hours ago
    CMD="node $appDir/mediainfo/mediaInfo.js -s $siteID -l 2 -p $configDirPath"
    $CMD
  
    # Processed all movies that were released more than 2 days ago, in case the above command did not 
    # process it.
    CMD="node $appDir/mediainfo/mediaInfo.js -s $siteID -p $configDirPath --released 2"
    $CMD
  done
done
