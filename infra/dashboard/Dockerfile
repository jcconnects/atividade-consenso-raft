FROM nginx:1.27-alpine
COPY index.html viz.js style.css /usr/share/nginx/html/
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY sse.inc /etc/nginx/conf.d/sse.inc
ENV RAFT_NODES="node1,node2,node3"
EXPOSE 80
