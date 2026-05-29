proxy_http_version 1.1;
proxy_set_header Connection '';
proxy_set_header Host $host;
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 24h;
chunked_transfer_encoding on;
