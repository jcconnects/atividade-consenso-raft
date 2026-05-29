FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY sse.inc /etc/nginx/conf.d/sse.inc
COPY index.html /usr/share/nginx/html/index.html
COPY style.css /usr/share/nginx/html/style.css
COPY js /usr/share/nginx/html/js
COPY docs /usr/share/nginx/html/docs

ENV RAFT_NODES="node1,node2,node3"

EXPOSE 80
