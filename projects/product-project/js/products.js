/* global $ _ */
$(function(){
$(document).ready(function () {
  // ALL YOUR CODE GOES BELOW HERE //
    $.getJSON('data/product.json', function (data) {
 console.log(data);

     $('#search').css('margin-top','20px').css('margin-bottom','5px');


   
                                            // search bar function  //
function search(data, target){
    function find(data, target){
        if(typeof data ==='string'){
            return data.toUpperCase().includes(target.toUpperCase());
        }else if(typeof data==='object'){
            return _.some(data,function(val){
                return find(val,target);
            });
        }
    }
    return _.filter(data,function(data){
        return find(data,target);
    });
              
}

$('#search').on('click', function() {
    let ser = search(data, $('input:text').val());
    display(ser);
});

function display(list) {
    $('main').empty();
    if (list.length === 0) {
        $('<div>').text('No Items Found').attr('class', 'text-center').css('font-size', '20px').css('font-weight', 'bold').appendTo('main');
    }
    _.map(list, function(list) {
        let row = $('<article>').attr('class', 'row');
        let thumbnail = 'img/product/thumbs/' + list.image;
        $('<img>').attr('src', thumbnail).attr('class', 'col-md-2').appendTo(row);
        let mainDesc = $('<section>').attr('class', 'col-md-6').appendTo(row);
        $('<desc>').text(list.desc).css('color', 'white').appendTo(mainDesc);

        $('main').append(popup(list));
        // row.on('click', function() {
        //     $("#" + list.id + "-modal").modal();
        // });

        row.appendTo('main');
        $('<div>').text('Price: $' + list.price).css('color', 'white').appendTo(mainDesc).css('font-size', '12px');
        if (list.stock < 10) {
            $('<section>').text("Only " + list.stock + " left in-stock!!! BUY IT NOW").css('color', 'red').css('font-size', '20px').appendTo(mainDesc);
        }
        else {
            $('<section>').text(list.stock + " left in-stock").css('color', 'white').appendTo(mainDesc);
        }
        $('<button>').text("Info").attr("id", "Bbutton").appendTo(row).on('click', function() {
            $("#" + list.id + "-modal").modal();
        });
        
    });

    }
display(data);

$('#filter').css('margin-top', '20px').css('margin-bottom', '4px');
var fTypes = _.unique(_.map(data, function(val, ind, col) {
    return val.type;
}));
_.map(fTypes, function(val) {
    $('<option>').text(val).appendTo('#filter');
});


function filter(data, target) {
    return _.filter(data, (el) => {

        return el.type === target;
    });
}

$('select').change(function() {
    if ($('select option:selected').text() === 'All') {
        display(data);
        return;
    }
    display(filter(data, ($('select option:selected').text())));
});


function popup(product) {
    let first = $('<div>').attr('class', 'modal fade').attr('role', "dialog").attr('id', product.id + "-modal");

    let second = $('<div>').attr('class', 'modal-dialog');
    first.append(second);

    let third = $('<div>').attr('class', 'modal-content');
    second.append(third);

    let forth = $('<div>').attr('class', 'modal-header');
    third.append(forth);
    forth.append($('<button>').attr('class', 'close').attr('data-dismiss', 'modal').wrapInner('&times;').css('color', 'white'));
    forth.append($('<h4>').attr('class', 'modal-title').text(product.desc).css('color', 'white'));

    let mBody = $('<div>').attr('class', 'modal-body  ');
    mBody.appendTo(forth);
    mBody.append($('<img>').attr('src', "img/product/" + product.image).attr('class', 'col-md-5').css('color', 'white'));

    let desc = $('<div>').attr('class', 'col-md-9');
    desc.wrapInner("<p><b>Available Colors:</b> " +
        product.availableColors + "</p><p><b>Specifications: </b>" +
        product.specs + "</p><p><b>Price:</b> " +
        '$' + product.price + "</p>").css('color', 'white');
    desc.append($('<p>').text(product.stock + ' left in stock').css('color', 'white'));

    mBody.append(desc);
    return first;
}

        
         
              
        // $('li').on('click', (e) => {
        //  let prodId = $(e.currentTarget).attr('data-product-id')
        //  let product = findProductById(productId);
        //  showProductDetails(product);
        // });
   
   
   
    }).fail(function(){console.log('noJSON');});
  // ALL YOUR CODE GOES ABOVE HERE //
    }); 
});
















