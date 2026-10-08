import socket
s = socket.socket()
s.connect(("1.1.1.1", 80))
print("connected")
