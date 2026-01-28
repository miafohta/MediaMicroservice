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
    CMD="node $appDir/mediainfo/mediaInfo.js -s $siteID -l 0 -p $configDirPath"
    $CMD
  done
done
