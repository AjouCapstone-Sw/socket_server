const { Server } = require("socket.io");
const wrtc = require("@koush/wrtc");
const { makePC } = require("./MyWebRTC");
const { Auction, AuctionHouse, Manage } = require("./auction/auction");
const {
  getProductByauction,
  getIsDescriptionTime,
  getIsAskAvoidTime,
  sellerIn,
} = require("./auction/util");
const { makeAuctionTimer } = require("./Timer/AuctionTimer");
const { auctionExit, otherAuctionJoinCheck } = require("./auction/handler");

const OP_TIME = 5000;
const DESCRIPTION_TIME = 60000;
const AVOID_ASK_TIME = DESCRIPTION_TIME + 10000;

const SocketMap = {};
// 상품 Seller의 PC
const ProductPC = {};
// 상품 Seller PC의 Stream 데이터
const ProductStream = {};
// 상품에 참여하는 사람들 정보
const ProductJoinUsers = {};
// 상품에 참여하는 모든 유저들의 pc 정보
const ProductUsersPC = {};
// user <=> productId
const UserMappingProductId = {};

const closeAuction = (productId) => {
  try {
    if (!AuctionList[productId]) return;
    const auctionHouse = AuctionList[productId];
    clearInterval(auctionHouse.op);
    clearInterval(auctionHouse.timer);

    const sellerId = ProductStream[productId].id;
    ProductPC[productId] = null;
    ProductJoinUsers[productId]?.forEach(
      ({ socketId }) => (ProductUsersPC[socketId] = null)
    );
    ProductJoinUsers[productId] = null;
    ProductStream[productId] = null;
    AuctionList[productId] = null;
    ProductUsersPC[sellerId] = null;
  } catch (e) {
    console.log("error 발생 : ", e);
  }
};

const findUserId = (productId, sockId) =>
  ProductJoinUsers[productId].filter(({ socketId }) => sockId === socketId)[0]
    ?.userId ?? "";

const AuctionList = {};

const socketInit = (server, app) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  app.set("io", io);
  io.on("connection", (socket) => {
    const req = socket.request;
    const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    console.log("socket 연결 성공 ip : ", ip);
    console.log(socket.id);

    //여기 부터 chating

    socket.on("setUid", (id) => {
      SocketMap[socket.id] = { id };
      console.log(SocketMap);
    });

    //  여기부터 rtc
    socket.on("close", ({ productId }) => {
      if (!ProductStream[productId]?.id) return;
      if (ProductStream[productId].id === socket.id) closeAuction(productId);
    });

    const createPC = (productId) => {
      const onIceCandidateCallback = ({ candidate }) => {
        io.to(socket.id).emit("getSenderCandidate", { candidate });
      };

      const onTrackCallback = (e) => {
        if (ProductStream[productId]) return;
        ProductStream[productId] = {
          id: socket.id,
          stream: e.streams[0],
          tracks: e.streams[0].getTracks(),
        };
      };

      const pc = makePC(onIceCandidateCallback, onTrackCallback);
      ProductPC[productId] = pc;
      ProductUsersPC[socket.id] = pc;
    };

    socket.on("forceExit", ({ userId }) => {
      const productId = SocketMap[socket.id].productId;
      if (ProductStream[productId].id !== socket.id) return;
      const auctionHouse = AuctionList[productId];
      const socketList = auctionHouse.users;
      const determinedBuyer = auctionHouse.conclusionUser?.buyer;
      const isNotDetermined = (id) =>
        ![this.seller, determinedBuyer].includes(id);
      const remainMembers = Array.from(socketList).filter(isNotDetermined);
      remainMembers.map((member) => io.to(member).emit("forceAuctionExit"));
      closeAuction(productId);
    });

    socket.on("openAuction", async ({ productId, userId }) => {
      if (ProductPC[productId]) return;
      SocketMap[socket.id] = {
        id: userId,
        productId,
      };
      (ProductJoinUsers[productId] ??= []).push({
        socketId: socket.id,
        userId,
      });

      createPC(productId);

      const { price, operateTime, perPrice } = await getProductByauction(
        productId
      );
      const auction = new Auction({ price, perPrice });
      const manage = new Manage({ operateTime });

      AuctionList[productId] = new AuctionHouse({
        seller: socket.id,
        auction,
        manage,
      });

      socket.join(productId);
      sellerIn(productId);

      io.to(productId).emit("updateAuctionStatus", {
        status: "",
        nextPrice: auction.price,
      });

      io.to(productId).emit(
        "callSeller",
        findUserId(productId, AuctionList[productId].getSeller())
      );

      const auctionTimer = makeAuctionTimer(
        manage,
        io,
        productId,
        AuctionList[productId]
      );

      let count = 0;
      let isAuctionStart = false;

      const opFunc = setInterval(
        (productId) => {
          const auctionHouse = AuctionList[productId];
          count++;
          if (count < DESCRIPTION_TIME / OP_TIME) return;

          if (!isAuctionStart) {
            io.to(productId).emit("startAuction", "start");
            isAuctionStart = true;
          }

          // 경매 끝났을 때
          if (!auctionHouse.manage.isRunning()) {
            clearInterval(auctionHouse.op);
            clearInterval(auctionTimer);
            auctionExit(
              auctionHouse,
              io,
              productId,
              findUserId(productId, AuctionList[productId].getSeller()),
              closeAuction,
              SocketMap
            );
            return;
            //호가 들어왔을 때
          } else if (
            auctionHouse.manage.isConclusionNow() &&
            auctionHouse.compare()
          ) {
            auctionHouse.conclusion(auctionHouse.manage.queue[0]);
            auctionHouse.auction.add();
            auctionHouse.manage.getRemainTime();
          }
          // 호가 없을 때, 경메 시작 후 10초 유예시간 줌
          else if (
            !auctionHouse.manage.isConclusionNow() &&
            count > AVOID_ASK_TIME / OP_TIME
          ) {
            clearInterval(auctionHouse.op);
            clearInterval(auctionTimer);
            auctionExit(
              auctionHouse,
              io,
              productId,
              findUserId(productId, AuctionList[productId].getSeller()),
              closeAuction,
              SocketMap
            );
            return;
          }

          if (count < AVOID_ASK_TIME / OP_TIME) return;

          io.to(productId).emit("updateAuctionStatus", {
            status: findUserId(
              productId,
              auctionHouse.conclusionUser?.buyer ?? ""
            ),
            nextPrice: auction.price,
          });

          auctionHouse.manage.initQueue();
        },
        OP_TIME,
        productId
      );

      AuctionList[productId].runAuction(opFunc, auctionTimer);

      socket.join(productId);
      io.to(productId).emit("joinUser", {
        userId,
        updatedUserLength: AuctionList[productId].getUserLength(),
      });

      io.to(productId).emit(
        "auctionStart",
        findUserId(productId, AuctionList[productId].getSeller())
      );
    });

    socket.on("conclusion", ({ productId, price }) => {
      if (AuctionList[productId] === undefined) return;
      AuctionList[productId].manage.tryConclusion({ buyer: socket.id, price });
    });

    socket.on("sendAskPrice", ({ productId }) => {
      if (AuctionList[productId] === undefined) return;
      const { manage, auction } = AuctionList[productId];
      manage.tryConclusion({ buyer: socket.id, price: auction.price });
    });

    socket.on("sendMessage", ({ productId, message, userId }) =>
      io
        .to(productId)
        .emit("receiveMessage", { userId: userId + " : ", message })
    );

    socket.on("senderOffer", async ({ sdp }) => {
      // socketToRoom[socket.id] = data.productId;
      const pc = ProductUsersPC[socket.id];

      pc.setRemoteDescription(sdp);

      const answerSdp = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVIdeo: true,
      });

      pc.setLocalDescription(answerSdp);

      io.to(socket.id).emit("getSenderAnswer", { sdp: answerSdp });
    });

    socket.on("senderCandidate", ({ candidate }) => {
      const pc = ProductUsersPC[socket.id];
      if (!candidate) return;
      pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    });

    socket.on("joinAuction", ({ productId, userId }) => {
      if (!ProductStream[productId]) {
        io.to(socket.id).emit("dontOpenAuction");
        return;
      }

      const otherAuctionProductId = otherAuctionJoinCheck(
        AuctionList,
        socket.id
      );

      if (otherAuctionProductId) {
        io.to(socket.id).emit("goUserAuction", { otherAuctionProductId });
        return;
      }

      SocketMap[socket.id] = {
        id: userId,
        productId,
      };
      const onIceCandidateCallback = ({ candidate }) => {
        io.to(socket.id).emit("getReceiverCandidate", { candidate });
      };
      const onTrackCallback = (e) => {
        console.log("ontrack");
        console.log(e);
      };

      const pc = makePC(onIceCandidateCallback, onTrackCallback);

      const stream = ProductStream[productId].stream;
      const tracks = ProductStream[productId].tracks;

      tracks.forEach((track) => pc.addTrack(track, stream));

      io.to(socket.id).emit(
        "callSeller",
        findUserId(productId, AuctionList[productId].seller)
      );

      ProductUsersPC[socket.id] = pc;
      (ProductJoinUsers[productId] ??= []).push({
        socketId: socket.id,
        userId,
      });

      if (AuctionList[productId] === undefined) return;
      AuctionList[productId].join(socket.id);

      socket.join(productId);
      io.to(productId).emit("joinUser", {
        userId,
        updatedUserLength: AuctionList[productId].getUserLength(),
      });

      io.to(productId).emit("updateAuctionStatus", {
        status: findUserId(
          productId,
          AuctionList[productId].conclusionUser?.buyer ?? ""
        ),
        nextPrice: AuctionList[productId].auction.price,
      });

      io.to(socket.id).emit(
        "callSeller",
        findUserId(productId, AuctionList[productId].getSeller())
      );
    });
    socket.on("receiverCandidate", ({ candidate, productId }) => {
      const pc = ProductUsersPC[socket.id];
      if (!candidate || !pc) return;
      pc.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    });

    socket.on("receiverOffer", async ({ sdp }) => {
      // socketToRoom[socket.id] = data.productId;

      const pc = ProductUsersPC[socket.id];
      if (!pc) return;
      pc.setRemoteDescription(sdp);

      const answerSdp = await pc.createAnswer({
        offerToReceiveAudio: true,
        offerToReceiveVIdeo: true,
      });

      if (!pc.localDescription) pc.setLocalDescription(answerSdp);

      io.to(socket.id).emit("getReceiverAnswer", { sdp: answerSdp });
    });

    /**

 */

    //   socket.on("leaveRoom", () => {
    //     try {
    //       let roomId = socketToRoom[socket.id];

    //       deleteUser(socket.id, roomId);
    //       closeReceiverPC(socket.id);
    //       closeSenderPCs(socket.id);
    //       app.get("io").to(roomId).emit("userExit", socket.id);
    //     } catch (error) {
    //       console.log(error);
    //     }
    //   });
    //   socket.on("disconnect", () => {
    //     try {
    //       console.log("disconnect : ", socket.id);
    //       let roomId = socketToRoom[socket.id];

    //       deleteUser(socket.id, roomId);
    //       closeReceiverPC(socket.id);
    //       closeSenderPCs(socket.id);
    //       app.get("io").to(roomId).emit("userExit", socket.id);
    //     } catch (error) {    //       console.log(error);
    //     }
    //   });
  });
};

exports.socketInit = socketInit;
