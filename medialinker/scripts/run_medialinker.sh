#!/bin/bash

#Application Dir
appDir='/home/mediaimport/mediainfo-app/current';

# Directory path to the site configuration files
configDirPath="$appDir/medialinker/config"

export PATH=/home/mediaimport/bin:$PATH;

#for nodeENV in production staging
for nodeENV in production
do
  export NODE_ENV=$nodeENV;

  for siteID in xxxx
  do
    # Process all movies last updated more than 24 hours ago
    CMD="node $appDir/medialinker/mediaLinker.js -s $siteID -l 24 -p $configDirPath"
    $CMD
  
  done
done
