#!/bin/sh
# Stamps css/js links in index.html with a new version so browsers load the update right away.
v=$(date +%Y%m%d%H%M)
sed -i -E "s#(href=\"css/[a-z-]+\.css)(\?v=[0-9]+)?\"#\1?v=$v\"#; s#(src=\"js/[a-z-]+\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#" index.html
echo "$v"
