#!/bin/bash

export NODE_ENV=production;
export PATH=/home/mediaimport/bin:$PATH;

echo $@;

if [ -z "$@" ]
then
  echo "ERROR: Please pass in a movie_id or list of movie_id's."
else
  echo "Processing individual mediaInfo for movie_ids ($@)...";
fi

# SiteID
site_id=xxxx;

#Application Dir
appDir='/home/mediaimport/mediainfo-app/current';

# Directory path to the site configuration files
configDirPath="$appDir/mediainfo/config";

re='^[0-9]+$';

# run media info foreach of the movied id's
# these movie ids are from reupdb movie.movies table
#for MOVIEID in 628 629 886 891 961 1162 1411 2314 2497
for MOVIEID in $@
do
  # -l 0 usually means process where the updated column is 'N' number of hours ago
  # but in this case we want process teh -m MOVIEID ignoring the updated time check
  # -m or --movieid is the movie id to process.
  if ! [[ $MOVIEID =~ $re ]] ; then
    echo "MovieID: ($MOVIEID) is not a number";
  else
    CMD="node $appDir/mediainfo/mediaInfo.js -s $site_id -p $configDirPath -l 0 -m $MOVIEID";
    $CMD
  fi

done
